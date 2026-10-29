import {
  type IgnoredMediaReason,
  isFileCopy,
  mediaOriginals,
  parseQueueMessage,
} from '@shotx/shared';
import type { MessageHandler } from '../sqs/consumer';
import { type FileCopyDeps, processFileCopy } from './copy-file';
import { processOriginal } from './process-original';

export interface MediaHandlerDeps extends FileCopyDeps {
  /** The media bucket; S3 event records for any other bucket are ignored. */
  bucket: string;
  /** Upper bound for one message (ffmpeg is killed after it), below SQS's 12 h cap. */
  maxProcessingMs: number;
}

/**
 * Consumer of the `media` queue: `original.completed` (the API after `POST /uploads/:id/complete`,
 * media.sweep, upload recovery), `file.copy` (`POST /drive/files/:id/copy`, media.sweep) and, on
 * AWS, S3 ObjectCreated events on `originals/`. Validates
 * the body with the shared schema (an invalid body throws QueueMessageError, which the consumer
 * treats as permanent) and processes each original `mediaOriginals` finds, in order. Both variants
 * may arrive for the same file (AWS sends the S3 event too); processOriginal is idempotent, so the
 * second one ends as `already-ready` or `superseded`.
 */
export function createMediaHandler(deps: MediaHandlerDeps): MessageHandler {
  return async (body, context) => {
    const message = parseQueueMessage('media', body);
    if (isFileCopy(message)) {
      // Before mediaOriginals, which throws on it: a copy is not an original to render.
      const log = context.log.child({
        fileId: message.fileId,
        sourceFileId: message.sourceFileId,
        photographerId: message.photographerId,
        source: 'file.copy',
      });
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(deps.maxProcessingMs)]);
      const outcome = await processFileCopy(message, deps, log, signal);
      log.info('file copy processed', { outcome });
      return;
    }
    const { originals, ignored } = mediaOriginals(message, deps.bucket);
    const reasons = new Map<IgnoredMediaReason, number>();
    for (const item of ignored) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    if (reasons.get('test-event') !== undefined) context.log.info('S3 test event; nothing to do');
    for (const reason of ['other-bucket', 'not-an-original'] as const) {
      const count = reasons.get(reason);
      // Keys are not logged: they may contain file names.
      if (count !== undefined) {
        context.log.warn('ignored S3 event records (check the bucket notification)', {
          reason,
          count,
        });
      }
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(deps.maxProcessingMs)]);
    for (const original of originals) {
      const log = context.log.child({
        fileId: original.fileId,
        photographerId: original.photographerId,
        source: original.source,
      });
      const outcome = await processOriginal(original, deps, log, signal);
      log.info('original processed', { outcome });
    }
  };
}
