import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designAssets } from '@shotx/db';
import {
  DESIGN_ASSET_MIME_TYPES,
  type DesignAssetConfig,
  type DesignAssetMessage,
  designAssetKeys,
} from '@shotx/shared';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ObjectStore } from '../aws/object-store';
import type { Db } from '../db';
import type { Logger } from '../logger';
import { applyQuotaMove } from '../quota';
import { MediaDecodeError, MediaFormatMismatchError } from './errors';
import { renderDesignAssetWeb } from './image';
import { MAGIC_BYTES_LENGTH, magicBytesMatch } from './magic';

export interface DesignAssetDeps {
  db: Db;
  store: ObjectStore;
  /** DESIGN_ASSET_* (loadDesignConfig(env).asset): long edge and quality of web.webp. */
  designAssets: Pick<DesignAssetConfig, 'longEdge' | 'webpQuality'>;
  tmpDir?: string | undefined;
}

/** Why the worker rejected a design image's bytes (logged; never shown to viewers). */
export type DesignAssetRejectReason =
  'MISSING_OBJECT' | 'SIZE_MISMATCH' | 'MAGIC_MISMATCH' | 'UNSUPPORTED_MIME';

export type DesignAssetOutcome =
  | 'not-found'
  | 'owner-mismatch'
  | 'purge-requested'
  | 'already-ready'
  | 'already-failed'
  | 'not-completed'
  | 'rejected'
  | 'undecodable'
  | 'ready'
  | 'superseded';

export interface DesignAssetRow {
  id: string;
  ownerId: string;
  mime: string;
  sizeBytes: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  verifiedAt: Date | null;
  purgeRequestedAt: Date | null;
}

const assetColumns = {
  id: designAssets.id,
  ownerId: designAssets.ownerId,
  mime: designAssets.mime,
  sizeBytes: designAssets.sizeBytes,
  status: designAssets.status,
  verifiedAt: designAssets.verifiedAt,
  purgeRequestedAt: designAssets.purgeRequestedAt,
};

export async function findDesignAsset(db: Db, id: string): Promise<DesignAssetRow | null> {
  const [row] = await db.select(assetColumns).from(designAssets).where(eq(designAssets.id, id));
  return row ?? null;
}

/** A completed (`processing`), unverified, live asset: the rows verify and reject may change. */
const unverified = (id: string) =>
  and(
    eq(designAssets.id, id),
    eq(designAssets.status, 'processing'),
    isNull(designAssets.verifiedAt),
    isNull(designAssets.purgeRequestedAt),
  );

/** A verified, live asset not yet ready or failed. */
const verifiedProcessing = (id: string) =>
  and(
    eq(designAssets.id, id),
    eq(designAssets.status, 'processing'),
    isNotNull(designAssets.verifiedAt),
    isNull(designAssets.purgeRequestedAt),
  );

/**
 * `failed` and the reservation released, in one transaction. False when the guard matched
 * nothing (already failed, verified, purge-requested or gone): nothing moved.
 */
async function rejectAsset(db: Db, id: string, log: Logger): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(designAssets)
      .set({ status: 'failed' })
      .where(unverified(id))
      .returning({ ownerId: designAssets.ownerId, sizeBytes: designAssets.sizeBytes });
    if (row === undefined) return false;
    await applyQuotaMove(tx, row.ownerId, 'releaseReserved', row.sizeBytes, log);
    return true;
  });
}

/**
 * `verified_at` set and the bytes moved reserved -> used, in one transaction. False when the
 * guard matched nothing (an earlier attempt verified it, or it failed or was purged meanwhile).
 */
async function verifyAsset(db: Db, id: string, log: Logger): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(designAssets)
      .set({ verifiedAt: sql`now()` })
      .where(unverified(id))
      .returning({ ownerId: designAssets.ownerId, sizeBytes: designAssets.sizeBytes });
    if (row === undefined) return false;
    await applyQuotaMove(tx, row.ownerId, 'commit', row.sizeBytes, log);
    return true;
  });
}

async function markAssetReady(
  db: Db,
  id: string,
  size: { width: number; height: number },
): Promise<boolean> {
  const updated = await db
    .update(designAssets)
    .set({ status: 'ready', width: size.width, height: size.height })
    .where(verifiedProcessing(id))
    .returning({ id: designAssets.id });
  return updated.length > 0;
}

/** Verified bytes that don't decode: `failed`, the bytes stay in used until the orphan purge. */
async function markAssetFailedAfterVerify(db: Db, id: string): Promise<void> {
  await db.update(designAssets).set({ status: 'failed' }).where(verifiedProcessing(id));
}

/**
 * Verified bytes that turned out to be another format (replaced after the magic-byte check):
 * `failed` with `verified_at` cleared and the bytes released from used, in one transaction, so
 * the row counts nowhere (fileQuotaBucket: failed and unverified), as for a rejected upload. The
 * caller deletes the objects after. False when the guard matched nothing.
 */
async function rejectAfterVerify(db: Db, id: string, log: Logger): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(designAssets)
      .set({ status: 'failed', verifiedAt: null })
      .where(verifiedProcessing(id))
      .returning({ ownerId: designAssets.ownerId, sizeBytes: designAssets.sizeBytes });
    if (row === undefined) return false;
    await applyQuotaMove(tx, row.ownerId, 'releaseUsed', row.sizeBytes, log);
    return true;
  });
}

const SHARP_FORMAT_BY_MIME: Record<string, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function isDesignAssetMime(mime: string): boolean {
  return (DESIGN_ASSET_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * The `design.asset` job (ADR 0013; designAssetMessageSchema in @shotx/shared is the spec).
 *
 * Idempotent under redelivery: a ready, failed or purge-requested row is a no-op; verify and
 * reject are guarded UPDATEs that move the quota in the same transaction, so bytes move at most
 * once; web.webp is overwritten with the same result; `ready` is a guarded UPDATE. A crash after
 * verify resumes at the render without moving bytes again. Never touches `share_designs`.
 */
export async function processDesignAsset(
  message: Pick<DesignAssetMessage, 'assetId' | 'photographerId'>,
  deps: DesignAssetDeps,
  log: Logger,
  signal: AbortSignal,
): Promise<DesignAssetOutcome> {
  const { db, store } = deps;
  const row = await findDesignAsset(db, message.assetId);
  if (row === null) {
    // Purged (the purge deletes the objects before the row) or never created: nothing to do.
    log.info('design asset has no row; nothing to do');
    return 'not-found';
  }
  if (row.ownerId !== message.photographerId) {
    log.error('design asset row belongs to another photographer than the message; ignored');
    return 'owner-mismatch';
  }
  const keys = designAssetKeys({ photographerId: row.ownerId, assetId: row.id });
  if (row.purgeRequestedAt !== null) return 'purge-requested';
  if (row.status === 'ready') return 'already-ready';
  if (row.status === 'failed') {
    // Rejected bytes: make sure the object is gone (a crash may have left it after the row).
    if (row.verifiedAt === null) await store.deleteObjects([keys.original]);
    return 'already-failed';
  }
  if (row.status === 'uploading') {
    // The api sends the job only after complete commits `processing`; an upload still in flight
    // is left to complete (or to the nightly expiry).
    log.warn('design asset is still uploading; nothing to do');
    return 'not-completed';
  }

  const verified = row.verifiedAt !== null;
  if (!verified) {
    if (!isDesignAssetMime(row.mime))
      return reject(row, keys.original, 'UNSUPPORTED_MIME', deps, log);
    const head = await store.head(keys.original);
    if (head === null) return reject(row, keys.original, 'MISSING_OBJECT', deps, log);
    if (head.size !== row.sizeBytes) return reject(row, keys.original, 'SIZE_MISMATCH', deps, log);
    const magic = await store.getRange(keys.original, 0, MAGIC_BYTES_LENGTH - 1);
    if (!magicBytesMatch(magic, row.mime)) {
      return reject(row, keys.original, 'MAGIC_MISMATCH', deps, log);
    }
    if (!(await verifyAsset(db, row.id, log))) return settleSuperseded(row, keys, deps, log);
  }

  signal.throwIfAborted();
  const workDir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), `design-${row.id}-`));
  try {
    const path = join(workDir, 'original');
    const downloaded = await store.download(keys.original, path, signal);
    if (downloaded.bytes !== row.sizeBytes) {
      // Verified at this size: a transient read problem, or the object changed. Retry; the DLQ
      // and media.sweep's cap report it if it persists.
      throw new Error('Downloaded size differs from the verified size');
    }
    const expectedFormat = SHARP_FORMAT_BY_MIME[row.mime];
    if (expectedFormat === undefined) throw new Error('Design asset MIME type has no format');
    let rendered;
    try {
      rendered = await renderDesignAssetWeb(path, expectedFormat, deps.designAssets);
    } catch (error) {
      if (error instanceof MediaFormatMismatchError) {
        // Row first, then the objects (a web.webp an earlier attempt wrote too): a redelivery
        // sees `failed` and unverified, and deletes the original again.
        const released = await rejectAfterVerify(db, row.id, log);
        await store.deleteObjects([keys.original, keys.web]);
        log.warn('rejected design asset', {
          reason: 'FORMAT_MISMATCH',
          format: error.actual ?? null,
          released,
          sizeBytes: row.sizeBytes,
        });
        return 'rejected';
      }
      if (!(error instanceof MediaDecodeError)) throw error;
      await markAssetFailedAfterVerify(db, row.id);
      log.warn('design asset does not decode; marked failed', { sizeBytes: row.sizeBytes });
      return 'undecodable';
    }
    signal.throwIfAborted();
    await store.put(keys.web, rendered.web, 'image/webp');
    if (!(await markAssetReady(db, row.id, rendered)))
      return settleSuperseded(row, keys, deps, log);
    log.info('design asset ready', {
      sizeBytes: row.sizeBytes,
      webBytes: rendered.web.length,
      width: rendered.width,
      height: rendered.height,
    });
    return 'ready';
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function reject(
  row: DesignAssetRow,
  originalKey: string,
  reason: DesignAssetRejectReason,
  deps: DesignAssetDeps,
  log: Logger,
): Promise<DesignAssetOutcome> {
  // Row first, then the object: after a crash in between, the redelivery sees `failed` and
  // deletes the object again.
  const released = await rejectAsset(deps.db, row.id, log);
  await deps.store.deleteObjects([originalKey]);
  log.warn('rejected design asset', { reason, released, sizeBytes: row.sizeBytes });
  return 'rejected';
}

/**
 * The row changed under us (purge requested, purged, or failed). When the purge took it, delete
 * both objects again: this attempt may have written web.webp after the purge deleted it.
 */
async function settleSuperseded(
  row: DesignAssetRow,
  keys: { original: string; web: string },
  deps: DesignAssetDeps,
  log: Logger,
): Promise<DesignAssetOutcome> {
  const current = await findDesignAsset(deps.db, row.id);
  if (current === null || current.purgeRequestedAt !== null) {
    await deps.store.deleteObjects([keys.original, keys.web]);
  }
  log.info('design asset changed while processing; stopped', {
    status: current?.status ?? 'deleted',
    purgeRequested: current?.purgeRequestedAt != null,
  });
  return 'superseded';
}
