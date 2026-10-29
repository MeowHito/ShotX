import { Inject, Injectable } from '@nestjs/common';
import { files, zipJobEntries, zipJobs } from '@shotx/db';
import {
  type CreateDownloadResponse,
  downloadObject,
  ERROR_CODES,
  type ErrorCode,
  faceOnlyGrantAllows,
  type DownloadObject,
  sanitizeOriginalName,
  uniqueZipEntryNames,
  type Viewer,
  viewerColumns,
  viewerKey,
  type ZipJobView,
} from '@shotx/shared';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { recordActivity, shareEventSource } from '../activity/activity';
import type { PublicContext } from '../auth/public.guard';
import type { ApiConfig } from '../config';
import { type Db, isUniqueViolation } from '../db/db';
import { mediaKindOf } from '../drive/media-urls';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { SignedUrls } from '../media/signed-urls';
import { type LoadedShare, ShareAccess } from '../share/share-access';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  QUEUE_SENDER,
  type QueueSender,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import { shareItemsScope } from './share-items';
import { browserViewers, enforceRate } from './share-page.service';

export type ZipJobRow = typeof zipJobs.$inferSelect;

/** `zip_jobs` condition: the job belongs to one of this browser's identities. */
function jobOfViewers(viewers: readonly Viewer[]): SQL {
  const userIds = viewers.flatMap((v) => (v.kind === 'user' ? [v.viewerId] : []));
  const anonIds = viewers.flatMap((v) => (v.kind === 'anon' ? [v.anonId] : []));
  return sql`(${userIds.length > 0 ? inArray(zipJobs.viewerId, userIds) : sql`false`} OR ${
    anonIds.length > 0 ? inArray(zipJobs.anonId, anonIds) : sql`false`
  })`;
}

function sameViewer(job: ZipJobRow, viewer: Viewer): boolean {
  const columns = viewerColumns(viewer);
  return job.viewerId === columns.viewerId && job.anonId === columns.anonId;
}

/** The archive's download name: the shared folder's name, sanitized. */
function zipFileName(share: LoadedShare): string {
  return sanitizeOriginalName(`${share.targetName === '' ? 'photos' : share.targetName}.zip`);
}

/**
 * Share downloads: one file is a signed URL (Content-Disposition attachment, download TTL, one
 * `download` event); several are a zip job (zip_jobs + zip_job_entries in one transaction, then
 * `zip.create` on the zip queue), polled with GET /s/:token/zip-jobs/:id.
 */
@Injectable()
export class DownloadsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(QUEUE_SENDER) private readonly queue: QueueSender,
    @Inject(ShareAccess) private readonly access: ShareAccess,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
  ) {}

  /**
   * The requested files with the object each download serves: every id must be in the share's
   * scope and, in face_only mode, in the viewer's grant; otherwise NOT_FOUND for the whole request.
   */
  private async resolve(
    share: LoadedShare,
    viewer: Viewer,
    fileIds: readonly string[],
  ): Promise<{ fileId: string; object: DownloadObject }[]> {
    const grant = await this.access.grant(share, viewer);
    const found = await this.db
      .select({
        id: files.id,
        name: files.name,
        mime: files.mime,
        s3Key: files.s3Key,
        webKey: files.webKey,
        previewKey: files.previewKey,
        sizeBytes: files.sizeBytes,
        webSizeBytes: files.webSizeBytes,
      })
      .from(files)
      .where(
        and(
          // fileInShareScopeSql: ready, live, inside the root's current path.
          shareItemsScope(share),
          inArray(files.id, [...fileIds]),
        ),
      );
    const byId = new Map(found.map((f) => [f.id, f]));
    return fileIds.map((fileId) => {
      const file = byId.get(fileId);
      if (file === undefined || !faceOnlyGrantAllows(share.mode, grant, fileId)) {
        throw notFound('File');
      }
      const object = downloadObject(
        { ...file, mediaKind: mediaKindOf(file.mime) },
        share.downloadSize,
      );
      if (object === null) throw notFound('File');
      return { fileId, object };
    });
  }

  // --- POST /s/:token/downloads ----------------------------------------------------------------------

  async create(
    token: string,
    ctx: PublicContext,
    fileIds: string[],
    idempotencyKey: string | undefined,
  ): Promise<CreateDownloadResponse> {
    const share = await this.access.open(token, ctx);
    if (!share.allowDownload) {
      throw new ApiError('DOWNLOAD_NOT_ALLOWED', 'This share does not allow downloads');
    }
    if (fileIds.length > 1 && idempotencyKey === undefined) {
      throw validationError(['headers', 'idempotency-key'], 'is required for more than one file');
    }
    const resolved = await this.resolve(share, ctx.viewer, fileIds);
    if (resolved.length === 1 && fileIds.length === 1) {
      return this.single(share, ctx, resolved[0] as (typeof resolved)[number]);
    }
    return this.zip(share, ctx, resolved, idempotencyKey ?? '');
  }

  private async single(
    share: LoadedShare,
    ctx: PublicContext,
    { fileId, object }: { fileId: string; object: DownloadObject },
  ): Promise<CreateDownloadResponse> {
    await enforceRate(
      this.limiter,
      `share-download:${share.id}:${viewerKey(ctx.viewer)}`,
      this.config.share.rateLimits.downloadPerViewer,
    );
    const signed = this.urls.download(object.key, object.fileName);
    await recordActivity(this.db, {
      type: 'download',
      ...shareEventSource(share, ctx.viewer),
      fileId,
      bytes: object.bytes,
      meta: null,
    });
    return {
      kind: 'file',
      file: {
        fileId,
        url: signed.url,
        fileName: object.fileName,
        expiresAt: signed.expiresAt.toISOString(),
      },
    };
  }

  /**
   * A zip job, idempotent per (share, Idempotency-Key): the same viewer with the same files gets
   * the existing job (and its message is sent again while it is queued, so a lost send heals);
   * another viewer or other files is IDEMPOTENCY_KEY_REUSED. New jobs are rate-limited per viewer
   * and checked against ZIP_MAX_FILES and ZIP_MAX_BYTES.
   */
  private async zip(
    share: LoadedShare,
    ctx: PublicContext,
    resolved: { fileId: string; object: DownloadObject }[],
    idempotencyKey: string,
  ): Promise<CreateDownloadResponse> {
    const replay = await this.replay(share, ctx, resolved, idempotencyKey);
    if (replay !== null) return replay;

    const { maxFiles, maxBytes } = this.config.share.zip;
    const bytes = resolved.reduce((sum, r) => sum + r.object.bytes, 0);
    if (resolved.length > maxFiles || bytes > maxBytes) {
      throw new ApiError('ZIP_TOO_LARGE', 'Too many files or bytes for one zip', {
        maxFiles,
        maxBytes,
        files: resolved.length,
        bytes,
      });
    }
    await enforceRate(
      this.limiter,
      `zip-create:${share.id}:${viewerKey(ctx.viewer)}`,
      this.config.share.rateLimits.zipCreatePerViewer,
    );

    const names = uniqueZipEntryNames(resolved.map((r) => r.object.fileName));
    let job: ZipJobRow;
    try {
      job = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(zipJobs)
          .values({
            photographerId: share.ownerId,
            shareId: share.id,
            ...viewerColumns(ctx.viewer),
            downloadSize: share.downloadSize,
            fileCount: resolved.length,
            totalBytes: bytes,
            idempotencyKey,
          })
          .returning();
        if (created === undefined) throw new Error('zip_jobs insert returned no row');
        await tx.insert(zipJobEntries).values(
          resolved.map((r, position) => ({
            jobId: created.id,
            photographerId: share.ownerId,
            position,
            fileId: r.fileId,
            name: names[position] ?? r.object.fileName,
          })),
        );
        return created;
      });
    } catch (error) {
      if (!isUniqueViolation(error, 'zip_jobs_idempotency_unique')) throw error;
      // A concurrent request with the same key won.
      const raced = await this.replay(share, ctx, resolved, idempotencyKey);
      if (raced === null) throw error;
      return raced;
    }
    await this.queue.send('zip', { type: 'zip.create', jobId: job.id });
    return { kind: 'zip', job: await this.view(share, ctx, job) };
  }

  private async replay(
    share: LoadedShare,
    ctx: PublicContext,
    resolved: { fileId: string }[],
    idempotencyKey: string,
  ): Promise<CreateDownloadResponse | null> {
    const [existing] = await this.db
      .select()
      .from(zipJobs)
      .where(and(eq(zipJobs.shareId, share.id), eq(zipJobs.idempotencyKey, idempotencyKey)));
    if (existing === undefined) return null;
    const entries = await this.db
      .select({ fileId: zipJobEntries.fileId })
      .from(zipJobEntries)
      .where(eq(zipJobEntries.jobId, existing.id))
      .orderBy(asc(zipJobEntries.position));
    const requested = new Set(resolved.map((r) => r.fileId));
    const same =
      sameViewer(existing, ctx.viewer) &&
      entries.length === requested.size &&
      entries.every((e) => requested.has(e.fileId));
    if (!same) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used before for another download',
      );
    }
    if (existing.status === 'queued') {
      await this.queue.send('zip', { type: 'zip.create', jobId: existing.id });
    }
    return { kind: 'zip', job: await this.view(share, ctx, existing) };
  }

  // --- GET /s/:token/zip-jobs/:id -------------------------------------------------------------------

  /**
   * A zip job of this share and this browser. The token's share passes the normal gates first
   * (NOT_FOUND, SHARE_EXPIRED, LOGIN_REQUIRED, PASSWORD_REQUIRED: the unlock cookie's path
   * `/api/s/{token}` covers this route); then the job is looked up by id AND the token's share AND
   * this browser's identities, so another share's or another viewer's job is NOT_FOUND. In
   * face_only mode every entry must still be in the viewer's grant. The first response that issues
   * the archive's URL writes the job's one `zip` event.
   */
  async job(token: string, id: string, ctx: PublicContext): Promise<ZipJobView> {
    const share = await this.access.open(token, ctx);
    const [job] = await this.db
      .select()
      .from(zipJobs)
      .where(
        and(eq(zipJobs.id, id), eq(zipJobs.shareId, share.id), jobOfViewers(browserViewers(ctx))),
      );
    if (job === undefined) throw notFound('Zip job');
    if (share.mode === 'face_only') {
      const grant = await this.access.grant(share, ctx.viewer);
      const entries = await this.db
        .select({ fileId: zipJobEntries.fileId })
        .from(zipJobEntries)
        .where(eq(zipJobEntries.jobId, job.id));
      if (!entries.every((e) => faceOnlyGrantAllows(share.mode, grant, e.fileId))) {
        throw notFound('Zip job');
      }
    }
    return this.view(share, ctx, job);
  }

  /** The job view; a ready, unexpired archive gets a signed URL (and maybe the zip event). */
  private async view(share: LoadedShare, ctx: PublicContext, job: ZipJobRow): Promise<ZipJobView> {
    const now = this.clock.now();
    if (
      job.status !== 'ready' ||
      job.resultKey === null ||
      job.expiresAt === null ||
      job.expiresAt <= now
    ) {
      return this.jobView(share, job, null);
    }
    const signed = this.urls.download(job.resultKey, zipFileName(share));
    const [first] = await this.db
      .update(zipJobs)
      .set({ urlIssuedAt: now })
      .where(and(eq(zipJobs.id, job.id), isNull(zipJobs.urlIssuedAt)))
      .returning({ id: zipJobs.id });
    if (first !== undefined) {
      await recordActivity(this.db, {
        type: 'zip',
        ...shareEventSource(share, ctx.viewer),
        fileId: null,
        bytes: job.resultBytes ?? 0,
        meta: { files: job.fileCount },
      });
    }
    return this.jobView(share, job, signed);
  }

  private jobView(
    share: LoadedShare,
    job: ZipJobRow,
    signed: { url: string; expiresAt: Date } | null,
  ): ZipJobView {
    return zipJobView(job, zipFileName(share), signed, this.clock.now());
  }
}

/**
 * The API view of a zip job (share or owner): `expired` once the archive's `expires_at` passed,
 * the signed download (when given) under `fileName`, and a known error code for failed jobs.
 */
export function zipJobView(
  job: ZipJobRow,
  fileName: string,
  signed: { url: string; expiresAt: Date } | null,
  now: Date,
): ZipJobView {
  const expired = job.status === 'ready' && job.expiresAt !== null && job.expiresAt <= now;
  const errorCode =
    job.status === 'failed'
      ? (ERROR_CODES as readonly string[]).includes(job.errorCode ?? '')
        ? (job.errorCode as ErrorCode)
        : 'INTERNAL_ERROR'
      : null;
  return {
    id: job.id,
    status: expired ? 'expired' : job.status,
    fileCount: job.fileCount,
    totalBytes: job.totalBytes,
    createdAt: job.createdAt.toISOString(),
    download:
      signed === null
        ? null
        : { url: signed.url, fileName, expiresAt: signed.expiresAt.toISOString() },
    availableUntil:
      job.status === 'ready' && !expired && job.expiresAt !== null
        ? job.expiresAt.toISOString()
        : null,
    errorCode,
  };
}
