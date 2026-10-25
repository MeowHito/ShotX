import { type FaceConfig, loadFaceConfig } from '@shotx/shared';
import { FACES_MIN_VISIBILITY_TIMEOUT_SECONDS, REKOGNITION_LIMITS } from './constants';

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

/** Inputs to the faces job budget that FaceConfig doesn't cover (`queues.faces.visibilityFloor`). */
export interface FacesJobBudget {
  /** Upper bound on one Rekognition request; the worker must set its SDK request timeout to it. */
  readonly rekognitionCallTimeoutSeconds: number;
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
  /** Cut-off tile faces, then (if that fails) the rollback of every face this attempt indexed. */
  readonly deleteFacesCalls: number;
  readonly totalCalls: number;
  readonly processingSeconds: number;
  /** Minimum visibility timeout for the faces queue. */
  readonly floorSeconds: number;
}

/**
 * Worst case for one faces message (one photo), from packages/face:
 *
 * - Every Rekognition call goes through `withRetry` with the background profile. Each of the
 *   FACE_REKOGNITION_MAX_ATTEMPTS attempts waits up to FACE_REKOGNITION_MAX_WAIT_MS for a
 *   rate-limit token and then makes the request (up to `rekognitionCallTimeoutSeconds`). Between
 *   attempts it backs off up to FACE_REKOGNITION_RETRY_MAX_MS.
 * - `indexPhoto` makes 1 + FACE_TILE_GRID² IndexFaces calls, one DeleteFaces call for faces cut
 *   off at tile edges, and on failure one more DeleteFaces call to roll back. Each delete covers at
 *   most (1 + FACE_TILE_GRID²) × FACE_INDEX_MAX_FACES ids, in batches of 4096.
 * - The job may first make sure the collection exists (`collectionCallsPerJob`).
 */
export function facesJobWorstCase(face: FaceConfig, budget: FacesJobBudget): FacesJobWorstCase {
  const { maxAttempts, maxWaitMs, retryMaxMs } = face.rekognition.background;
  const perCallMs =
    maxAttempts * (maxWaitMs + budget.rekognitionCallTimeoutSeconds * 1000) +
    (maxAttempts - 1) * retryMaxMs;
  const grid = face.index.tileGrid;
  const indexFacesCalls = 1 + grid * grid;
  const deleteBatches = Math.ceil(
    (indexFacesCalls * face.index.maxFaces) / REKOGNITION_LIMITS.deleteFacesBatch,
  );
  const deleteFacesCalls = 2 * deleteBatches;
  const totalCalls = budget.collectionCallsPerJob + indexFacesCalls + deleteFacesCalls;
  const seconds = Math.ceil((totalCalls * perCallMs) / 1000 + budget.processingSeconds);
  return {
    perCallSeconds: perCallMs / 1000,
    collectionCalls: budget.collectionCallsPerJob,
    indexFacesCalls,
    deleteFacesCalls,
    totalCalls,
    processingSeconds: budget.processingSeconds,
    floorSeconds: Math.max(FACES_MIN_VISIBILITY_TIMEOUT_SECONDS, seconds),
  };
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
    REKOGNITION_LIMITS.inlineImageMaxBytes,
    Math.ceil(edge * edge * budget.jpegBytesPerPixel),
  );
  return {
    maxSelfies: face.search.maxSelfies,
    selfieMaxBytes,
    maxBodyBytes: face.search.maxSelfies * selfieMaxBytes + budget.multipartOverheadBytes,
  };
}
