import {
  type FaceConfig,
  loadFaceConfig,
  REKOGNITION_INLINE_IMAGE_MAX_BYTES,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
} from '@shotx/shared';
import { REKOGNITION_DELETE_FACES_BATCH } from './constants';

const SECONDS_PER_DAY = 86_400;

/**
 * Limits that infra derives from the face configuration in packages/shared. They're computed
 * with `loadFaceConfig`, the same parser api and worker use, so infra can't drift from the
 * defaults or from the FACE_* overrides in `services.env`.
 */

type EnvMap = Readonly<Record<string, string>>;

/** The `services.env` groups (see lib/config.ts). */
export interface ServiceEnvGroups {
  readonly common: EnvMap;
  readonly backend: EnvMap;
  readonly web: EnvMap;
  readonly admin: EnvMap;
  readonly api: EnvMap;
  readonly worker: EnvMap;
}

/** Extra variables one backend service gets, merged in the order lib/constructs/services.ts uses. */
export function backendEnv(env: ServiceEnvGroups, service: 'api' | 'worker'): EnvMap {
  return { ...env.common, ...env.backend, ...env[service] };
}

/** The FaceConfig a backend service will load at runtime. Throws on invalid FACE_* values. */
export function serviceFaceConfig(env: ServiceEnvGroups, service: 'api' | 'worker'): FaceConfig {
  return loadFaceConfig(backendEnv(env, service));
}

// --- faces queue -------------------------------------------------------------------------------

/** Inputs to the faces job worst case that FaceConfig doesn't cover (`queues.faces.jobBudget`). */
export interface FacesJobBudget {
  /** CreateCollection, then DescribeCollection when the collection already exists. */
  readonly collectionCallsPerJob: number;
  /** Decode, tile encodes, tmp/index/ puts and deletes, local detector and DB writes. */
  readonly processingSeconds: number;
}

export interface FacesJobWorstCase {
  /** Longest one background-profile call can take, retries and rate-limit waits included. */
  readonly perCallSeconds: number;
  readonly collectionCalls: number;
  /** The full image plus FACE_TILE_GRID² tiles. */
  readonly indexFacesCalls: number;
  /** Previous faces (re-index), cut-off tile faces, then the rollback if the attempt fails. */
  readonly deleteFacesCalls: number;
  readonly totalCalls: number;
  readonly processingSeconds: number;
  /** Longest one faces message (one photo, one attempt) can keep a worker busy. */
  readonly seconds: number;
}

/**
 * Worst case for one faces message (one photo), from packages/face:
 *
 * - Every Rekognition call goes through `withRetry` with the background profile. Each of the
 *   FACE_REKOGNITION_MAX_ATTEMPTS attempts waits up to FACE_REKOGNITION_MAX_WAIT_MS for a
 *   rate-limit token and then makes the request, which the SDK aborts after
 *   FACE_REKOGNITION_REQUEST_TIMEOUT_MS. Between attempts it backs off up to
 *   FACE_REKOGNITION_RETRY_MAX_MS.
 * - `indexPhoto` makes 1 + FACE_TILE_GRID² IndexFaces calls and up to three DeleteFaces calls:
 *   the file's previous faces when it is re-indexed, the faces cut off at tile edges, and the
 *   rollback of every face the attempt indexed when it fails. Each covers at most
 *   (1 + FACE_TILE_GRID²) × FACE_INDEX_MAX_FACES ids, in batches of 4096.
 * - The job may first make sure the collection exists (`collectionCallsPerJob`).
 */
export function facesJobWorstCase(face: FaceConfig, budget: FacesJobBudget): FacesJobWorstCase {
  const { maxAttempts, maxWaitMs, retryMaxMs } = face.rekognition.background;
  const perCallMs =
    maxAttempts * (maxWaitMs + face.rekognition.requestTimeoutMs) + (maxAttempts - 1) * retryMaxMs;
  const grid = face.index.tileGrid;
  const indexFacesCalls = 1 + grid * grid;
  const deleteBatches = Math.ceil(
    (indexFacesCalls * face.index.maxFaces) / REKOGNITION_DELETE_FACES_BATCH,
  );
  const deleteFacesCalls = 3 * deleteBatches;
  const totalCalls = budget.collectionCallsPerJob + indexFacesCalls + deleteFacesCalls;
  return {
    perCallSeconds: perCallMs / 1000,
    collectionCalls: budget.collectionCallsPerJob,
    indexFacesCalls,
    deleteFacesCalls,
    totalCalls,
    processingSeconds: budget.processingSeconds,
    seconds: Math.ceil((totalCalls * perCallMs) / 1000 + budget.processingSeconds),
  };
}

/** One problem with a queue's visibility settings, as a validation message. */
export interface QueueTimingIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

export interface HeartbeatQueueSettings {
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
  readonly retentionDays: number;
}

/**
 * Checks a queue whose worst-case job is longer than its visibility timeout. The worker keeps the
 * message invisible with ChangeMessageVisibility every third of the timeout, so the timeout only
 * decides how fast a crashed worker's message comes back. The job itself must still fit:
 *
 * 1. SQS caps a message's total invisibility at 12 hours from the receive; heartbeats can't
 *    extend past it.
 * 2. maxReceiveCount × timeout covers the worst case, so a job that is merely slow is never moved
 *    to the dead-letter queue by redeliveries alone, even if heartbeats stop.
 * 3. maxReceiveCount attempts that each run the worst case and then crash, each followed by the
 *    timeout, end before the retention period does, so a failing message reaches the DLQ
 *    instead of expiring unseen.
 */
export function heartbeatQueueIssues(
  queue: HeartbeatQueueSettings,
  worstCaseSeconds: number,
  describe: string,
): QueueTimingIssue[] {
  const issues: QueueTimingIssue[] = [];
  const { visibilityTimeoutSeconds: t, maxReceiveCount: r } = queue;
  if (worstCaseSeconds > SQS_MAX_VISIBILITY_TIMEOUT_SECONDS) {
    issues.push({
      path: [],
      message:
        `the worst case (${worstCaseSeconds}s: ${describe}) exceeds SQS's 12 h visibility cap ` +
        `(${SQS_MAX_VISIBILITY_TIMEOUT_SECONDS}s), which heartbeats can't extend`,
    });
  }
  if (r * t < worstCaseSeconds) {
    issues.push({
      path: ['visibilityTimeoutSeconds'],
      message:
        `maxReceiveCount × visibilityTimeoutSeconds (${r} × ${t}s = ${r * t}s) must cover the ` +
        `worst case of ${worstCaseSeconds}s (${describe}); raise one of them`,
    });
  }
  const exhaustSeconds = r * (worstCaseSeconds + t);
  if (exhaustSeconds > queue.retentionDays * SECONDS_PER_DAY) {
    issues.push({
      path: ['retentionDays'],
      message:
        `maxReceiveCount × (worst case + visibilityTimeoutSeconds) = ${exhaustSeconds}s must fit ` +
        `in the retention period, or a failing message expires before it reaches the DLQ`,
    });
  }
  return issues;
}

/**
 * Orphan reconciliation deletes a face without a `faces` row only after FACE_ORPHAN_GRACE_MS, and
 * an indexing attempt must commit its rows within half of it (packages/face
 * `recordFacesDeadline`). The grace must therefore be at least twice the longest attempt.
 */
export function minOrphanGraceMs(worst: FacesJobWorstCase): number {
  return 2 * worst.seconds * 1000;
}

// --- face search request body ------------------------------------------------------------------

/** Inputs to the face-search body limit that FaceConfig doesn't cover (`waf.faceSearchBody`). */
export interface FaceSearchBodyBudget {
  /** Upper bound on JPEG bytes per pixel. 3 is uncompressed 24-bit RGB. */
  readonly jpegBytesPerPixel: number;
  /** Multipart boundaries, part headers and small form fields. */
  readonly multipartOverheadBytes: number;
}

export interface FaceSearchBodyLimits {
  readonly maxSelfies: number;
  /** One selfie: FACE_SELFIE_LONG_EDGE² pixels, never above Rekognition's inline image limit. */
  readonly selfieMaxBytes: number;
  /** A whole face-search request: FACE_MAX_SELFIES selfies plus multipart overhead. */
  readonly maxBodyBytes: number;
}

export function faceSearchBodyLimits(
  face: FaceConfig,
  budget: FaceSearchBodyBudget,
): FaceSearchBodyLimits {
  const edge = face.selfie.longEdge;
  const selfieMaxBytes = Math.min(
    REKOGNITION_INLINE_IMAGE_MAX_BYTES,
    Math.ceil(edge * edge * budget.jpegBytesPerPixel),
  );
  return {
    maxSelfies: face.search.maxSelfies,
    selfieMaxBytes,
    maxBodyBytes: face.search.maxSelfies * selfieMaxBytes + budget.multipartOverheadBytes,
  };
}
