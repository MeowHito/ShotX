/** An enqueue that didn't finish within QUEUE_ENQUEUE_TIMEOUT_MS (Redis or SQS unreachable). */
export class EnqueueTimeoutError extends Error {
  override readonly name = 'EnqueueTimeoutError';

  constructor(queue: string, timeoutMs: number) {
    super(`Enqueue to ${queue} timed out after ${timeoutMs} ms`);
  }
}

/**
 * Runs one enqueue with a deadline: rejects with EnqueueTimeoutError after `timeoutMs` and aborts
 * `signal` (SQS SendMessage honours it; a BullMQ `add` can't be cancelled and may still land
 * later, which consumers tolerate because every job is idempotent and checks its rows). The
 * caller's request fails and runs its rollback instead of hanging.
 */
export async function withEnqueueTimeout<T>(
  queue: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EnqueueTimeoutError(queue, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
