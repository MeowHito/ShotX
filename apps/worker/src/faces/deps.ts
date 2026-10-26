import type { FaceProvider, TempImageStore } from '@shotx/face';
import type { FaceConfig, FeatureFlags, RetentionConfig } from '@shotx/shared';
import type { ObjectStore } from '../aws/object-store';
import type { QueueSender } from '../queue/sender';
import type { Db } from '../db';

/**
 * Makes sure a photographer's collection exists before indexing into it. CreateCollection (and
 * DescribeCollection when it already exists) runs once per collection per process, not per photo.
 */
export class CollectionRegistry {
  private readonly ensured = new Map<string, Promise<void>>();

  constructor(private readonly provider: Pick<FaceProvider, 'createCollection'>) {}

  ensure(collectionId: string): Promise<void> {
    let pending = this.ensured.get(collectionId);
    if (pending === undefined) {
      pending = this.provider.createCollection(collectionId).then(() => undefined);
      // A failed attempt is not remembered: the next job tries again.
      pending.catch(() => this.ensured.delete(collectionId));
      this.ensured.set(collectionId, pending);
    }
    return pending;
  }

  /** Forgets a collection that turned out to be gone, so the next job creates it again. */
  forget(collectionId: string): void {
    this.ensured.delete(collectionId);
  }
}

export interface FacesDeps {
  db: Db;
  store: ObjectStore;
  queues: QueueSender;
  /** The faces queue's destination for `queues`: its SQS URL, or `faces` on BullMQ. */
  facesQueueUrl: string;
  provider: FaceProvider;
  /** Where indexPhoto puts its temporary index images (S3 `tmp/index/` in production). */
  tempStore: TempImageStore;
  collections: CollectionRegistry;
  face: FaceConfig;
  features: FeatureFlags;
  retention: Pick<RetentionConfig, 'faceIndexExpiryDays'>;
  /** Rows per batch for fan-out and unindexing. */
  batchSize: number;
  /** Longest processing of one faces message. */
  maxProcessingMs: number;
  tmpDir?: string | undefined;
  now: () => number;
  /** Tests pin indexing attempt ids. */
  newAttemptId?: (() => string) | undefined;
}
