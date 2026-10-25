import { createdOriginals, isS3TestEvent, parseQueueMessage } from '@shotx/shared';
import type { MessageHandler } from '../sqs/consumer';
import { type MediaDeps, processOriginal } from './process-original';

export interface MediaHandlerDeps extends MediaDeps {
  /** The media bucket; records for any other bucket are ignored. */
  bucket: string;
  /** Upper bound for one message (ffmpeg is killed after it), below SQS's 12 h cap. */
  maxProcessingMs: number;
}

/**
 * Consumer of the `media` queue (S3 ObjectCreated on `originals/`). Validates the body with the
 * shared schema (an invalid body throws QueueMessageError, which the consumer treats as
 * permanent), deletes S3's TestEvent, and processes each created original in order.
 */
export function createMediaHandler(deps: MediaHandlerDeps): MessageHandler {
  return async (body, context) => {
    const message = parseQueueMessage('media', body);
    if (isS3TestEvent(message)) {
      context.log.info('S3 test event; nothing to do');
      return;
    }
    const { originals, ignored } = createdOriginals(message);
    if (ignored.length > 0) {
      // Keys are not logged: they may contain file names.
      context.log.warn('ignored objects outside originals/ (check the bucket notification)', {
        count: ignored.length,
      });
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(deps.maxProcessingMs)]);
    for (const original of originals) {
      const log = context.log.child({
        fileId: original.fileId,
        photographerId: original.photographerId,
      });
      if (original.bucket !== deps.bucket) {
        log.warn('ignored an object of another bucket');
        continue;
      }
      const outcome = await processOriginal(original, deps, log, signal);
      log.info('original processed', { outcome });
    }
  };
}
