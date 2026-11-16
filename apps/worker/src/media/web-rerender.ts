import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files } from '@shotx/db';
import { type MediaConfig, type WebRerenderMessage } from '@shotx/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { ObjectStore } from '../aws/object-store';
import type { Db } from '../db';
import type { Logger } from '../logger';
import { MediaDecodeError } from './errors';
import { renderWebJpeg } from './image';

export interface WebRerenderDeps {
  db: Db;
  store: ObjectStore;
  media: MediaConfig;
  tmpDir?: string | undefined;
}

export type WebRerenderOutcome =
  | 'not-found'
  | 'owner-mismatch'
  | 'not-applicable'
  | 'under-cap'
  | 'undecodable'
  | 'superseded'
  | 'rerendered';

/**
 * `web.rerender` (ADR 0028; contract at webRerenderMessageSchema): web.jpg of a ready image again,
 * under MEDIA_WEB_MAX_BYTES. Idempotent: a row already under the cap (or no longer ready, or
 * purge-requested) is left alone, and the object is overwritten in place under the same key.
 */
export async function processWebRerender(
  message: WebRerenderMessage,
  deps: WebRerenderDeps,
  log: Logger,
  signal: AbortSignal,
): Promise<WebRerenderOutcome> {
  const maxBytes = deps.media.web.maxBytes;
  const [row] = await deps.db
    .select({
      ownerId: files.ownerId,
      mime: files.mime,
      status: files.status,
      s3Key: files.s3Key,
      webKey: files.webKey,
      webSizeBytes: files.webSizeBytes,
      purgeRequestedAt: files.purgeRequestedAt,
    })
    .from(files)
    .where(eq(files.id, message.fileId));
  if (row === undefined) return 'not-found';
  if (row.ownerId !== message.photographerId) return 'owner-mismatch';
  if (
    row.status !== 'ready' ||
    !row.mime.startsWith('image/') ||
    row.webKey === null ||
    row.purgeRequestedAt !== null
  ) {
    return 'not-applicable';
  }
  if (maxBytes === 0 || row.webSizeBytes === null || row.webSizeBytes <= maxBytes) {
    return 'under-cap';
  }

  signal.throwIfAborted();
  const workDir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), `web-${message.fileId}-`));
  try {
    const originalPath = join(workDir, 'original');
    await deps.store.download(row.s3Key, originalPath, signal);
    let web: Buffer;
    try {
      web = await renderWebJpeg(originalPath, deps.media);
    } catch (error) {
      if (!(error instanceof MediaDecodeError)) throw error;
      log.warn('original no longer decodes; web.jpg left as it is');
      return 'undecodable';
    }
    signal.throwIfAborted();
    await deps.store.put(row.webKey, web, 'image/jpeg');
    const updated = await deps.db
      .update(files)
      .set({ webSizeBytes: web.length })
      .where(
        and(
          eq(files.id, message.fileId),
          eq(files.status, 'ready'),
          eq(files.webKey, row.webKey),
          isNull(files.purgeRequestedAt),
        ),
      )
      .returning({ id: files.id });
    if (updated.length === 0) return 'superseded';
    log.info('web.jpg rendered under the cap', {
      before: row.webSizeBytes,
      after: web.length,
      maxBytes,
    });
    return 'rerendered';
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
