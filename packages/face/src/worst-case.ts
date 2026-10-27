import type { FaceConfig } from '@shotx/shared';
import { REKOGNITION_DELETE_FACES_BATCH } from './provider';
import type { RekognitionProfile } from './rekognition-limits';
import { RECORD_FACES_SHARE_OF_GRACE } from './reconcile';
import { rekognitionRetryOptions } from './rekognition-provider';
import { retryBackoffCapMs } from './throttling';

/**
 * Upper bounds on how long Rekognition calls can take, computed from FaceConfig with the same
 * rules the provider follows. Use them to check `FACE_ORPHAN_GRACE_MS` and queue visibility
 * timeouts against the configuration in use.
 *
 * Not included, because they are outside the provider's control: the Redis round trip of each
 * rate-limit reservation, timer and event-loop lateness (a sleep or the request timeout firing
 * late), and everything around the calls (encoding the image and tiles, the local detector,
 * database writes). Add a margin for them.
 */

export interface RekognitionCallWorstCase {
  /** Attempts per call (`maxAttempts` of the profile). */
  attempts: number;
  /** Longest wait for a rate-limit slot, per attempt (`maxWaitMs` of the profile). */
  rateLimitWaitMs: number;
  /** Longest single request, per attempt (`requestTimeoutMs`). */
  requestTimeoutMs: number;
  /** Sum of the backoff caps between attempts. */
  backoffMs: number;
  /** attempts × (rateLimitWaitMs + requestTimeoutMs) + backoffMs. */
  totalMs: number;
}

/**
 * The longest one provider call (e.g. one `indexFaces` or one DeleteFaces batch) can take: every
 * attempt waits the full `maxWaitMs` for its slot (a longer wait fails fast with
 * RateLimitedError) and then runs into `requestTimeoutMs`, with the longest backoff between
 * attempts. IndexFaces retries only throttling, which is never slower than this.
 */
export function rekognitionCallWorstCase(
  config: FaceConfig['rekognition'],
  profile: RekognitionProfile,
): RekognitionCallWorstCase {
  const retry = rekognitionRetryOptions(config, profile);
  let backoffMs = 0;
  for (let attempt = 1; attempt < retry.maxAttempts; attempt++) {
    backoffMs += retryBackoffCapMs(attempt, retry);
  }
  const rateLimitWaitMs = config[profile].maxWaitMs;
  const { requestTimeoutMs } = config;
  return {
    attempts: retry.maxAttempts,
    rateLimitWaitMs,
    requestTimeoutMs,
    backoffMs,
    totalMs: retry.maxAttempts * (rateLimitWaitMs + requestTimeoutMs) + backoffMs,
  };
}

export interface IndexPhotoWorstCaseOptions {
  /** Length of `previousFaceIds` when re-indexing; 0 (the default) for a first indexing. */
  previousFaces?: number | undefined;
}

export interface IndexPhotoWorstCase {
  /** One background-profile call, see `rekognitionCallWorstCase`. */
  perCallMs: number;
  /** The full image plus FACE_TILE_GRID² tiles. */
  indexFacesCalls: number;
  /**
   * DeleteFaces batches: `previousFaceIds` before indexing, faces cut off at inner tile edges,
   * and (when that or anything else fails) the rollback of every face the attempt indexed.
   */
  deleteFacesCalls: number;
  totalCalls: number;
  /** totalCalls × perCallMs: the Rekognition part of one `indexPhoto` call. */
  rekognitionMs: number;
  /**
   * The smallest FACE_ORPHAN_GRACE_MS whose `recordFacesDeadline` still lies after
   * `rekognitionMs` (2 × rekognitionMs). Add twice the processing time and a margin on top.
   */
  minOrphanGraceMs: number;
}

/** The longest one `indexPhoto` attempt spends in Rekognition calls, with the worker profile. */
export function indexPhotoWorstCase(
  config: FaceConfig,
  options: IndexPhotoWorstCaseOptions = {},
): IndexPhotoWorstCase {
  const batches = (ids: number) => Math.ceil(ids / REKOGNITION_DELETE_FACES_BATCH);
  const { tileGrid, maxFaces } = config.index;
  const tiles = tileGrid * tileGrid;
  const indexFacesCalls = 1 + tiles;
  const deleteFacesCalls =
    batches(options.previousFaces ?? 0) +
    batches(tiles * maxFaces) +
    batches(indexFacesCalls * maxFaces);
  const perCallMs = rekognitionCallWorstCase(config.rekognition, 'background').totalMs;
  const totalCalls = indexFacesCalls + deleteFacesCalls;
  const rekognitionMs = totalCalls * perCallMs;
  return {
    perCallMs,
    indexFacesCalls,
    deleteFacesCalls,
    totalCalls,
    rekognitionMs,
    minOrphanGraceMs: Math.ceil(rekognitionMs / RECORD_FACES_SHARE_OF_GRACE),
  };
}
