import { Inject, Injectable } from '@nestjs/common';
import {
  childFolderDepth,
  type DriveFile as DriveFileRow,
  driveNameKeySql,
  files,
  type Folder,
  folders,
  storageUsage,
} from '@shotx/db';
import {
  checkUploadDeclaration,
  type CompleteUploadResponse,
  driveNameKey,
  type ListPartsResponse,
  type MultipartPlan,
  multipartPlan,
  originalCompletedMessage,
  originalKey,
  parseS3Key,
  partsMatchPlan,
  reserveQuota,
  sanitizeOriginalName,
  type SignPartsResponse,
  subscriptionAllowsUploads,
  type uploadInitBodySchema,
  type UploadInitResponse,
} from '@shotx/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type ApiConfig, apiSendsMediaJobs } from '../config';
import { type Db, isUniqueViolation, type Queryable, type Tx } from '../db/db';
import {
  currentSubscription,
  reserveQuotaBytes,
  storageCounters,
  uploadGate,
} from '../drive/account';
import { insertFolder, liveFolder, newId } from '../drive/folders';
import { DriveFileMapper, toDriveFolder } from '../drive/media-urls';
import { folderParentIs, withFreeName } from '../drive/names';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  EVENT_LOG,
  OBJECT_STORAGE,
  type ObjectStorage,
  QUEUE_SENDER,
  type QueueSender,
  RATE_LIMITER,
  type RateLimiter,
  type UploadedPart,
} from '../tokens';
import type { EventLog } from '../infra/events';

type InitBody = z.output<typeof uploadInitBodySchema>;

const uploadNotFound = () => new ApiError('UPLOAD_NOT_FOUND', 'No pending upload with this id');

/** ETags compare without their surrounding quotes (clients may send either form). */
export function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^"(.*)"$/, '$1');
}

/** The multipart plan an upload was created with (`files.upload_part_bytes`, fixed at init). */
export function storedPlan(sizeBytes: number, uploadPartBytes: number): MultipartPlan {
  return multipartPlan(sizeBytes, uploadPartBytes);
}

/**
 * Whether the parts S3 has are exactly the upload's plan (the part size stored at init), so the
 * object can't differ from the reserved size. A change of UPLOAD_PART_BYTES after init doesn't
 * matter: the stored part size is used.
 */
export function partsFitUpload(
  sizeBytes: number,
  uploadPartBytes: number,
  parts: readonly { partNumber: number; size: number }[],
): boolean {
  return partsMatchPlan(storedPlan(sizeBytes, uploadPartBytes), sizeBytes, parts);
}

/** An open upload row: `upload_id` and `upload_part_bytes` are set together (CHECK). */
type OpenUpload = DriveFileRow & { uploadId: string; uploadPartBytes: number };

function partBytesOf(file: DriveFileRow): number {
  if (file.uploadPartBytes === null) throw new Error('Open upload without upload_part_bytes');
  return file.uploadPartBytes;
}

/**
 * Presigned multipart uploads (Uppy `@uppy/aws-s3`). Bytes go from the browser straight to S3;
 * the API only reserves quota, creates the row, signs part URLs and completes or aborts. Quota
 * changes happen in DB transactions with the guarded statements from drive/quota.
 */
@Injectable()
export class UploadService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DriveFileMapper) private readonly mapper: DriveFileMapper,
    @Inject(QUEUE_SENDER) private readonly queue: QueueSender,
    @Inject(EVENT_LOG) private readonly events: EventLog,
  ) {}

  // --- POST /uploads/init --------------------------------------------------------------------

  /**
   * Starts an upload. With `clientUploadId`, inits are idempotent per photographer: a transaction
   * advisory lock on (owner, clientUploadId) serialises retries, and an existing row is replayed
   * (same declaration, still open: same fileId, fresh part URLs, nothing reserved again), or
   * answered IDEMPOTENCY_KEY_REUSED (other declaration) or CONFLICT (completed, failed, expired).
   */
  async init(ownerId: string, body: InitBody): Promise<UploadInitResponse> {
    const { limit, windowSeconds } = this.config.limits.uploadInitRate;
    const rate = await this.rateLimiter.hit(`upload-init:${ownerId}`, limit, windowSeconds);
    if (!rate.allowed) {
      throw new ApiError('RATE_LIMITED', 'Too many uploads started; try again later', undefined, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    const declaration = checkUploadDeclaration(
      { name: body.name, mime: body.mime, sizeBytes: body.size },
      this.config.upload.maxBytes,
    );
    if (!declaration.ok) {
      throw new ApiError(
        declaration.code,
        declaration.code === 'FILE_TOO_LARGE'
          ? 'The file is over the size limit for its type'
          : 'This file type is not supported',
        declaration.details,
      );
    }
    const { fileType } = declaration;
    const plan = multipartPlan(body.size, this.config.upload.partBytes);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.upload.sessionTtlSeconds * 1000);

    let opened: { key: string; uploadId: string } | null = null;
    let result:
      | { kind: 'created'; file: DriveFileRow; created: Folder[] }
      | { kind: 'existing'; file: DriveFileRow; sameDeclaration: boolean };
    try {
      result = await this.db.transaction(async (tx) => {
        if (body.clientUploadId !== undefined) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload-init:${ownerId}:${body.clientUploadId}`}, 0))`,
          );
          const [existing] = await tx
            .select()
            .from(files)
            .where(and(eq(files.ownerId, ownerId), eq(files.clientUploadId, body.clientUploadId)));
          if (existing !== undefined) {
            return {
              kind: 'existing' as const,
              file: existing,
              sameDeclaration: await this.sameDeclaration(
                tx,
                ownerId,
                existing,
                body,
                fileType.mime,
              ),
            };
          }
        }

        // ADR 0010: the subscription gates uploads only with BILLING_MODE=gateway, and the
        // quota only with STORAGE_QUOTA_ENFORCED; `quotaBytes` null reserves without a limit.
        const gate = uploadGate(this.config);
        let quotaBytes: number | null = null;
        if (gate.subscription || gate.quota) {
          // FOR SHARE: a plan change (FOR UPDATE in the billing transactions) and this
          // reservation serialise, so the quota read below is the one the reservation runs under.
          const subscription = await currentSubscription(tx, ownerId, { lock: 'share' });
          if (gate.subscription && !subscriptionAllowsUploads(subscription?.status ?? null)) {
            throw new ApiError('SUBSCRIPTION_INACTIVE', 'Uploads need an active subscription', {
              status: subscription?.status ?? null,
            });
          }
          if (gate.quota) {
            quotaBytes = subscription?.quotaBytes ?? 0;
            // Cheap pre-check so a full account doesn't open a multipart upload; the guarded
            // statement below is what decides.
            const precheck = reserveQuota(
              { ...(await storageCounters(tx, ownerId)), quotaBytes },
              body.size,
            );
            if (!precheck.ok) throw quotaExceeded(precheck.details);
          }
        }

        let parent: Folder | null = null;
        if (body.folderId !== null) {
          parent = await liveFolder(tx, ownerId, body.folderId, 'share');
          if (parent === null) throw notFound('Folder');
        }
        const created: Folder[] = [];
        for (const name of body.relativePath ?? []) {
          const next = await this.findOrCreateFolder(tx, ownerId, parent, name);
          if (next.created) created.push(next.folder);
          parent = next.folder;
        }

        const fileId = await newId(tx);
        const key = originalKey({
          photographerId: ownerId,
          fileId,
          originalName: sanitizeOriginalName(body.name),
        });
        const uploadId = await this.storage.createMultipartUpload({
          key,
          contentType: fileType.mime,
        });
        opened = { key, uploadId };

        if (!(await reserveQuotaBytes(tx, ownerId, body.size, quotaBytes)) && quotaBytes !== null) {
          const again = reserveQuota(
            { ...(await storageCounters(tx, ownerId)), quotaBytes },
            body.size,
          );
          throw quotaExceeded(
            again.ok
              ? {
                  quotaBytes,
                  usedBytes: 0,
                  reservedBytes: 0,
                  requestedBytes: body.size,
                  availableBytes: 0,
                }
              : again.details,
          );
        }

        const folderId = parent?.id ?? null;
        const insert = (q: Tx, name: string) =>
          q
            .insert(files)
            .values({
              id: fileId,
              ownerId,
              folderId,
              name,
              mime: fileType.mime,
              sizeBytes: body.size,
              s3Key: key,
              status: 'uploading',
              uploadId,
              // Written with upload_id (CHECK files_upload_part_bytes_valid): signParts and
              // complete use this plan even if UPLOAD_PART_BYTES changes meanwhile.
              uploadPartBytes: plan.partSize,
              clientUploadId: body.clientUploadId ?? null,
              uploadExpiresAt: expiresAt,
            })
            .returning();
        let inserted: DriveFileRow[];
        if (body.onNameConflict === 'fail') {
          try {
            inserted = await tx.transaction((sp) => insert(sp, body.name));
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new ApiError('NAME_TAKEN', 'A file with this name already exists here', {
                kind: 'file',
                name: body.name,
              });
            }
            throw error;
          }
        } else {
          inserted = await withFreeName(
            tx,
            { ownerId, kind: 'file', parentId: folderId, name: body.name },
            insert,
          );
        }
        const [file] = inserted;
        if (file === undefined) throw new Error('File insert returned no row');
        return { kind: 'created' as const, file, created };
      });
    } catch (error) {
      const toAbort = opened as { key: string; uploadId: string } | null;
      if (toAbort !== null) await this.storage.abortMultipartUpload(toAbort).catch(() => undefined);
      throw error;
    }

    if (result.kind === 'existing') return this.replayInit(result.file, result.sameDeclaration);
    return this.initResponse(result.file, result.created, now);
  }

  /** The init response for an open upload row: first part URLs, plan and session end. */
  private async initResponse(
    file: DriveFileRow,
    created: Folder[],
    now: Date,
  ): Promise<UploadInitResponse> {
    const uploadId = file.uploadId;
    if (uploadId === null || file.uploadExpiresAt === null) {
      throw new Error('initResponse needs an open upload');
    }
    const plan = storedPlan(file.sizeBytes, partBytesOf(file));
    const partTtl = this.partUrlTtlSeconds(now, file.uploadExpiresAt);
    const first = Math.min(this.config.upload.initPresignedParts, plan.partCount);
    const parts = await Promise.all(
      Array.from({ length: first }, async (_, i) => ({
        partNumber: i + 1,
        url: await this.storage.presignUploadPart({
          key: file.s3Key,
          uploadId,
          partNumber: i + 1,
          expiresInSeconds: partTtl,
        }),
      })),
    );
    return {
      fileId: file.id,
      uploadId,
      file: this.mapper.toDriveFile(file),
      createdFolders: created.map(toDriveFolder),
      partSize: plan.partSize,
      partCount: plan.partCount,
      maxConcurrency: this.config.upload.partConcurrency,
      parts,
      partUrlsExpireAt: new Date(now.getTime() + partTtl * 1000).toISOString(),
      expiresAt: file.uploadExpiresAt.toISOString(),
    };
  }

  /**
   * A retry of an init that already created `file`. Folders the first init created are not
   * reported again (`createdFolders` is empty): the client refreshes the folder listing.
   */
  private replayInit(file: DriveFileRow, sameDeclaration: boolean): Promise<UploadInitResponse> {
    if (!sameDeclaration) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'clientUploadId was used before for another file declaration',
      );
    }
    const now = this.clock.now();
    const open =
      file.uploadId !== null &&
      file.status === 'uploading' &&
      file.deletedAt === null &&
      file.purgeRequestedAt === null &&
      file.uploadExpiresAt !== null &&
      now < file.uploadExpiresAt;
    if (!open) {
      throw new ApiError('CONFLICT', 'This upload was already completed, failed or expired');
    }
    return this.initResponse(file, [], now);
  }

  /**
   * Whether a retried init declares the same file as the stored row: size, canonical MIME, the
   * name in the original's key (the display name may have been renamed to ` (2)`), and the
   * folder that folderId + relativePath resolve to now.
   */
  private async sameDeclaration(
    q: Queryable,
    ownerId: string,
    file: DriveFileRow,
    body: InitBody,
    mime: string,
  ): Promise<boolean> {
    if (file.sizeBytes !== body.size || file.mime !== mime) return false;
    const parsed = parseS3Key(file.s3Key);
    if (parsed?.kind !== 'original' || parsed.originalName !== sanitizeOriginalName(body.name)) {
      return false;
    }
    let folderId: string | null = body.folderId;
    for (const name of body.relativePath ?? []) {
      const [child] = await q
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.ownerId, ownerId),
            folderParentIs(folderId),
            isNull(folders.deletedAt),
            sql`${driveNameKeySql(folders.name)} = ${driveNameKey(name)}`,
          ),
        );
      if (child === undefined) return false;
      folderId = child.id;
    }
    return folderId === file.folderId;
  }

  /** Part URLs live UPLOAD_PRESIGN_TTL_SECONDS, but never past the session's end. */
  private partUrlTtlSeconds(now: Date, sessionEnd: Date): number {
    const left = Math.floor((sessionEnd.getTime() - now.getTime()) / 1000);
    return Math.max(1, Math.min(this.config.upload.presignTtlSeconds, left));
  }

  /** The live child folder named `name` under `parent`, created when missing (race-safe). */
  private async findOrCreateFolder(
    tx: Tx,
    ownerId: string,
    parent: Folder | null,
    name: string,
  ): Promise<{ folder: Folder; created: boolean }> {
    const find = async () => {
      const [row] = await tx
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.ownerId, ownerId),
            folderParentIs(parent?.id ?? null),
            isNull(folders.deletedAt),
            sql`${driveNameKeySql(folders.name)} = ${driveNameKey(name)}`,
          ),
        )
        .for('share');
      return row ?? null;
    };
    const existing = await find();
    if (existing !== null) return { folder: existing, created: false };
    const max = this.config.drive.maxFolderDepth;
    if (childFolderDepth(parent?.path ?? null) > max) {
      throw new ApiError('FOLDER_DEPTH_EXCEEDED', 'The folder tree would be too deep', {
        maxDepth: max,
      });
    }
    try {
      const folder = await tx.transaction((sp) =>
        insertFolder(sp, {
          ownerId,
          parent,
          name,
          now: this.clock.now(),
          faceIndexExpiryDays: this.config.retention.faceIndexExpiryDays,
        }),
      );
      return { folder, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another upload of the same drop created it first.
      const raced = await find();
      if (raced === null) throw error;
      return { folder: raced, created: false };
    }
  }

  // --- shared lookups ------------------------------------------------------------------------

  private async findUpload(ownerId: string, id: string): Promise<DriveFileRow> {
    const [file] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.ownerId, ownerId)));
    if (file === undefined || file.purgeRequestedAt !== null) throw uploadNotFound();
    return file;
  }

  /** An upload that is still open: CONFLICT once completed, UPLOAD_EXPIRED past its session. */
  private async openUpload(ownerId: string, id: string): Promise<OpenUpload> {
    const file = await this.findUpload(ownerId, id);
    if (file.uploadId === null) throw new ApiError('CONFLICT', 'The upload is already completed');
    if (file.uploadExpiresAt !== null && this.clock.now() >= file.uploadExpiresAt) {
      throw new ApiError('UPLOAD_EXPIRED', 'The upload session has expired');
    }
    return { ...file, uploadId: file.uploadId, uploadPartBytes: partBytesOf(file) };
  }

  // --- POST /uploads/:id/parts ---------------------------------------------------------------

  async signParts(ownerId: string, id: string, partNumbers: number[]): Promise<SignPartsResponse> {
    const file = await this.openUpload(ownerId, id);
    const { partCount } = storedPlan(file.sizeBytes, file.uploadPartBytes);
    partNumbers.forEach((n, i) => {
      if (n > partCount) {
        throw validationError(['body', 'partNumbers', i], `must be at most ${partCount}`);
      }
    });
    const now = this.clock.now();
    const ttl = this.partUrlTtlSeconds(now, file.uploadExpiresAt ?? now);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart({
          key: file.s3Key,
          uploadId: file.uploadId,
          partNumber,
          expiresInSeconds: ttl,
        }),
      })),
    );
    return { parts, expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
  }

  // --- GET /uploads/:id/parts ----------------------------------------------------------------

  async listParts(ownerId: string, id: string): Promise<ListPartsResponse> {
    const file = await this.openUpload(ownerId, id);
    const parts = await this.storage.listParts({ key: file.s3Key, uploadId: file.uploadId });
    if (parts === null) throw uploadNotFound();
    return { parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag, size: p.size })) };
  }

  // --- POST /uploads/:id/complete ------------------------------------------------------------

  /**
   * Completes the multipart upload after checking the parts against S3 (ListParts plus
   * partsFitUpload with the stored part size), so the object is exactly the reserved size.
   * Idempotent: an upload already completed returns its file, and a retry after S3 completed but
   * before the row was updated recovers through HeadObject.
   */
  async complete(
    ownerId: string,
    id: string,
    sent: { partNumber: number; etag: string }[],
  ): Promise<CompleteUploadResponse> {
    const file = await this.findUpload(ownerId, id);
    if (file.uploadId === null) return { file: this.mapper.toDriveFile(file) };
    if (file.uploadExpiresAt !== null && this.clock.now() >= file.uploadExpiresAt) {
      throw new ApiError('UPLOAD_EXPIRED', 'The upload session has expired');
    }
    const uploadId = file.uploadId;
    const s3Parts = await this.storage.listParts({ key: file.s3Key, uploadId });
    if (s3Parts === null) return this.recoverCompleted(ownerId, file, uploadId);
    if (
      !sentPartsMatch(sent, s3Parts) ||
      !partsFitUpload(file.sizeBytes, partBytesOf(file), s3Parts)
    ) {
      throw new ApiError(
        'UPLOAD_PARTS_INVALID',
        'The uploaded parts do not match the declared size or the ETags sent',
      );
    }
    const completed = await this.storage.completeMultipartUpload({
      key: file.s3Key,
      uploadId,
      parts: s3Parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    });
    if (!completed) return this.recoverCompleted(ownerId, file, uploadId);
    return this.markCompleted(ownerId, file.id, uploadId);
  }

  /** S3 has no such upload any more: done if the object exists with the declared size. */
  private async recoverCompleted(
    ownerId: string,
    file: DriveFileRow,
    uploadId: string,
  ): Promise<CompleteUploadResponse> {
    const head = await this.storage.headObject(file.s3Key);
    if (head === null || head.size !== file.sizeBytes) throw uploadNotFound();
    return this.markCompleted(ownerId, file.id, uploadId);
  }

  /**
   * Clears upload_id (and upload_part_bytes with it), moves `uploading` to `processing` and stamps
   * media_queued_at (with either backend), guarded by the UploadId, in one statement. After it
   * commits and with QUEUE_BACKEND=bullmq, starts the media pipeline with `original.completed`
   * (ADR 0008 section 2: R2 has no bucket notifications; on SQS the S3 ObjectCreated event does
   * it and the api sends nothing to `media`). An enqueue failure is logged
   * (`media.enqueue_failed`) and does not fail the request: media.sweep re-sends for
   * `processing` rows whose media_queued_at is old.
   */
  private async markCompleted(
    ownerId: string,
    fileId: string,
    uploadId: string,
  ): Promise<CompleteUploadResponse> {
    const [updated] = await this.db
      .update(files)
      .set({
        uploadId: null,
        uploadPartBytes: null,
        status: sql`CASE WHEN ${files.status} = 'uploading' THEN 'processing'::file_status ELSE ${files.status} END`,
        mediaQueuedAt: this.clock.now(),
      })
      .where(and(eq(files.id, fileId), eq(files.ownerId, ownerId), eq(files.uploadId, uploadId)))
      .returning();
    if (updated !== undefined) {
      if (updated.status === 'processing' && apiSendsMediaJobs(this.config)) {
        await this.startMedia(updated);
      }
      return { file: this.mapper.toDriveFile(updated) };
    }
    const current = await this.findUpload(ownerId, fileId);
    if (current.uploadId !== null) throw uploadNotFound();
    return { file: this.mapper.toDriveFile(current) };
  }

  /** Sends `original.completed`; failures are logged only (ids, never the key: it holds the name). */
  private async startMedia(file: DriveFileRow): Promise<void> {
    try {
      await this.queue.send(
        'media',
        originalCompletedMessage({
          fileId: file.id,
          photographerId: file.ownerId,
          key: file.s3Key,
        }),
      );
    } catch (error) {
      this.events.warn('media.enqueue_failed', {
        fileId: file.id,
        photographerId: file.ownerId,
        queue: 'media',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  // --- DELETE /uploads/:id -------------------------------------------------------------------

  /**
   * Aborts an open upload: S3 AbortMultipartUpload, then deletes the row and releases its
   * reservation in one transaction (guarded as in drive/quota). A completed upload is CONFLICT.
   * Deleting the row frees its clientUploadId.
   */
  async abort(ownerId: string, id: string): Promise<void> {
    const file = await this.findUpload(ownerId, id);
    if (file.uploadId === null) throw new ApiError('CONFLICT', 'The upload is already completed');
    const uploadId = file.uploadId;
    await this.storage.abortMultipartUpload({ key: file.s3Key, uploadId });
    const released = await this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(files)
        .where(
          and(
            eq(files.id, file.id),
            eq(files.ownerId, ownerId),
            eq(files.uploadId, uploadId),
            eq(files.status, 'uploading'),
            isNull(files.verifiedAt),
            isNull(files.purgeRequestedAt),
          ),
        )
        .returning({ sizeBytes: files.sizeBytes });
      if (deleted === undefined) return false;
      await tx
        .update(storageUsage)
        .set({
          reservedBytes: sql`greatest(0, ${storageUsage.reservedBytes} - ${deleted.sizeBytes})`,
        })
        .where(eq(storageUsage.photographerId, ownerId));
      return true;
    });
    if (!released) {
      const [current] = await this.db
        .select({ uploadId: files.uploadId })
        .from(files)
        .where(and(eq(files.id, file.id), eq(files.ownerId, ownerId)));
      if (current === undefined) throw uploadNotFound();
      throw new ApiError('CONFLICT', 'The upload is already completed');
    }
  }
}

function quotaExceeded(details: {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  requestedBytes: number;
  availableBytes: number;
}): ApiError {
  return new ApiError('QUOTA_EXCEEDED', 'Not enough storage left in the plan', details);
}

/** The parts the client sent are exactly the parts S3 has, with the same ETags. */
function sentPartsMatch(
  sent: readonly { partNumber: number; etag: string }[],
  s3Parts: readonly UploadedPart[],
): boolean {
  if (sent.length !== s3Parts.length) return false;
  return sent.every((p, i) => {
    const s = s3Parts[i];
    return (
      s !== undefined &&
      s.partNumber === p.partNumber &&
      normalizeEtag(s.etag) === normalizeEtag(p.etag)
    );
  });
}
