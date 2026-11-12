import { loadDesignConfig, loadWorkerSettings } from '@shotx/shared';
import type { JobsHandlerDeps } from '../jobs/handler';
import { MemoryQueueClient } from './memory-aws';

/** Destinations tests send to (any string works with MemoryQueueClient). */
export const TEST_DESTINATIONS = { media: 'test://media', faces: 'test://faces' } as const;

/**
 * The queue and sweep dependencies of the jobs handler and JobContext, with the default
 * settings (loadWorkerSettings({}), loadDesignConfig({})). `queues.sent` shows what the jobs enqueued.
 */
export function testJobQueues(queues = new MemoryQueueClient()): Pick<
  JobsHandlerDeps,
  | 'queues'
  | 'destinations'
  | 'sweeps'
  | 'authSessionRetentionDays'
  | 'faceSearchEnabled'
  | 'designAssets'
> & {
  queues: MemoryQueueClient;
} {
  return {
    queues,
    destinations: { ...TEST_DESTINATIONS },
    sweeps: loadWorkerSettings({}).sweeps,
    authSessionRetentionDays: 7,
    faceSearchEnabled: true,
    designAssets: loadDesignConfig({}).asset,
  };
}
