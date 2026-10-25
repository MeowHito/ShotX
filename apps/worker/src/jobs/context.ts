import type { ObjectStore } from '../aws/object-store';
import type { Db } from '../db';
import type { FaceDeleter } from '../faces';
import type { Logger } from '../logger';

export interface JobContext {
  db: Db;
  store: ObjectStore;
  faces: FaceDeleter;
  log: Logger;
  now: () => number;
  /** Rows per batch. */
  batchSize: number;
  /** Epoch ms after which no new batch starts; the rest waits for the next run. */
  deadline: number;
  /** Aborted on shutdown or when the message is lost: the run stops and is retried. */
  signal: AbortSignal;
}

/** False when the run must stop starting batches. Throws when aborted. */
export function mayContinue(ctx: JobContext): boolean {
  ctx.signal.throwIfAborted();
  return ctx.now() < ctx.deadline;
}

export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  return groups;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
