import { z } from 'zod';
import { DEFAULT_AWS_REGION } from './aws';
import { type Env, parseEnv } from './env';
import {
  int,
  MiB,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  SECONDS_PER_DAY,
  SECONDS_PER_MINUTE,
} from './fields';

export const QUALITY_FILTERS = ['NONE', 'AUTO', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type QualityFilter = (typeof QUALITY_FILTERS)[number];

/**
 * When the worker also indexes overlapping tiles of a photo:
 * - `never`: full image only.
 * - `signal`: when Rekognition skips faces as too small or too many, or the local detector sees a
 *   face narrower than `FACE_SMALL_FACE_RATIO` of the image width.
 * - `always`: every photo.
 */
export const TILING_MODES = ['never', 'signal', 'always'] as const;
export type TilingMode = (typeof TILING_MODES)[number];

const percent = z.coerce.number().min(0).max(100);
const ratio = z.coerce.number().min(0).max(1);
/** Calls per second for one Rekognition operation: a whole number from 1 to 1000. */
const tps = int(1, 1000);
const requests = int(1, 1_000_000);
const windowSeconds = int(1, SECONDS_PER_DAY);

// Defaults are the starting values from the platform spec. The face PoC decides the real ones.
const faceEnvSchema = z
  .object({
    FACE_STRONG: percent.default(95),
    FACE_MAYBE: percent.default(85),
    FACE_MAX_SELFIES: int(1, 5).default(3),
    FACE_EXPANSION_SEEDS: int(0, 10).default(2),
    FACE_SEARCH_MAX_FACES: int(1, 4096).default(1000),
    FACE_SEARCH_QUALITY_FILTER: z.enum(QUALITY_FILTERS).default('AUTO'),
    FACE_SELFIE_LONG_EDGE: int(320, 4096).default(1280),
    FACE_SELFIE_JPEG_QUALITY: int(50, 100).default(90),
    FACE_INDEX_LONG_EDGE: int(640, 8192).default(3500),
    FACE_INDEX_JPEG_QUALITY: int(50, 100).default(90),
    FACE_INDEX_MAX_BYTES: int(1, 15 * MiB).default(15 * MiB),
    FACE_INDEX_MAX_FACES: int(1, 100).default(100),
    FACE_INDEX_QUALITY_FILTER: z.enum(QUALITY_FILTERS).default('LOW'),
    FACE_INDEX_TILING: z.enum(TILING_MODES).default('signal'),
    FACE_TILE_GRID: int(1, 4).default(2),
    FACE_TILE_OVERLAP: z.coerce.number().min(0).max(0.5).default(0.15),
    FACE_TILE_EDGE_EPSILON: z.coerce.number().min(0).max(0.1).default(0.01),
    FACE_SMALL_FACE_RATIO: ratio.default(0.02),
    FACE_ORPHAN_GRACE_MS: int(MS_PER_MINUTE, MS_PER_DAY).default(3 * MS_PER_HOUR),
    FACE_DEDUPE_IOU: ratio.default(0.5),
    FACE_ENCODE_QUALITY_STEP: int(1, 25).default(5),
    FACE_ENCODE_MIN_QUALITY: int(30, 100).default(60),
    FACE_ENCODE_SHRINK_FACTOR: z.coerce.number().min(0.5).max(0.95).default(0.85),
    FACE_ENCODE_MIN_LONG_EDGE: int(64, 1024).default(320),
    FACE_REKOGNITION_TPS_INDEX_FACES: tps.default(5),
    FACE_REKOGNITION_TPS_SEARCH_FACES_BY_IMAGE: tps.default(5),
    FACE_REKOGNITION_TPS_SEARCH_FACES: tps.default(5),
    FACE_REKOGNITION_TPS_DELETE_FACES: tps.default(5),
    FACE_REKOGNITION_TPS_LIST_FACES: tps.default(5),
    FACE_REKOGNITION_TPS_COLLECTION: tps.default(5),
    FACE_REKOGNITION_BURST_SECONDS: z.coerce.number().positive().max(1).default(1),
    FACE_REKOGNITION_REQUEST_TIMEOUT_MS: int(1000, 120_000).default(10_000),
    FACE_REKOGNITION_RATE_LIMIT_PREFIX: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9:_.-]+$/)
      .default('shotx:rekognition'),
    FACE_REKOGNITION_MAX_ATTEMPTS: int(1, 20).default(8),
    FACE_REKOGNITION_RETRY_BASE_MS: int(1, 60_000).default(200),
    FACE_REKOGNITION_RETRY_MAX_MS: int(1, 300_000).default(10_000),
    FACE_REKOGNITION_MAX_WAIT_MS: int(0, 600_000).default(30_000),
    FACE_REKOGNITION_INTERACTIVE_MAX_ATTEMPTS: int(1, 10).default(3),
    FACE_REKOGNITION_INTERACTIVE_RETRY_BASE_MS: int(1, 10_000).default(100),
    FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS: int(1, 30_000).default(1000),
    FACE_REKOGNITION_INTERACTIVE_MAX_WAIT_MS: int(0, 30_000).default(2000),
    // Face-search requests (POST /s/:token/face-search, any number of selfies) allowed per window.
    // The spec's FACE_SEARCH_RATE is 10 per IP per 10 minutes; the per-share and per-viewer
    // defaults are assumptions to be load-tested.
    FACE_SEARCH_RATE_PER_IP: requests.default(10),
    FACE_SEARCH_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
    FACE_SEARCH_RATE_PER_SHARE: requests.default(1200),
    FACE_SEARCH_RATE_PER_SHARE_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
    FACE_SEARCH_RATE_PER_VIEWER: requests.default(10),
    FACE_SEARCH_RATE_PER_VIEWER_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
    AWS_REGION: z.string().min(1).default(DEFAULT_AWS_REGION),
  })
  .refine((env) => env.FACE_STRONG >= env.FACE_MAYBE, {
    error: 'FACE_STRONG must be greater than or equal to FACE_MAYBE',
  })
  .refine((env) => env.FACE_ENCODE_MIN_LONG_EDGE <= env.FACE_SELFIE_LONG_EDGE, {
    error: 'FACE_ENCODE_MIN_LONG_EDGE must be less than or equal to FACE_SELFIE_LONG_EDGE',
  })
  .refine((env) => env.FACE_ENCODE_MIN_LONG_EDGE <= env.FACE_INDEX_LONG_EDGE, {
    error: 'FACE_ENCODE_MIN_LONG_EDGE must be less than or equal to FACE_INDEX_LONG_EDGE',
  })
  .refine((env) => env.FACE_REKOGNITION_RETRY_BASE_MS <= env.FACE_REKOGNITION_RETRY_MAX_MS, {
    error:
      'FACE_REKOGNITION_RETRY_BASE_MS must be less than or equal to FACE_REKOGNITION_RETRY_MAX_MS',
  })
  .refine(
    (env) =>
      env.FACE_REKOGNITION_INTERACTIVE_RETRY_BASE_MS <=
      env.FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS,
    {
      error:
        'FACE_REKOGNITION_INTERACTIVE_RETRY_BASE_MS must be less than or equal to FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS',
    },
  );

export interface FaceThresholds {
  /** Matches at or above this similarity are shown as "ใช่คุณ" and may seed expansion. */
  strong: number;
  /** Matches at or above this similarity are shown as "อาจจะเป็นคุณ". */
  maybe: number;
}

/** At most `limit` requests per `windowSeconds`. */
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface FaceConfig {
  thresholds: FaceThresholds;
  search: {
    maxSelfies: number;
    expansionSeeds: number;
    maxFaces: number;
    qualityFilter: QualityFilter;
  };
  /**
   * Request limits for face search, enforced by the API before any Rekognition call. One request
   * counts once however many selfies it carries. A viewer is the logged-in user or, when
   * anonymous, the `anon_id` cookie.
   */
  searchRateLimits: {
    perIp: RateLimitRule;
    perShare: RateLimitRule;
    perViewer: RateLimitRule;
  };
  selfie: { longEdge: number; jpegQuality: number };
  index: {
    longEdge: number;
    jpegQuality: number;
    maxBytes: number;
    maxFaces: number;
    qualityFilter: QualityFilter;
    tiling: TilingMode;
    tileGrid: number;
    tileOverlap: number;
    /** A face box this close to a tile edge (fraction of the tile size) counts as touching it. */
    tileEdgeEpsilon: number;
    smallFaceRatio: number;
    dedupeIou: number;
    /**
     * Orphan reconciliation (`faces.reconcile.daily`) deletes a face that is in the collection
     * but has no `faces` row only once it has stayed unknown for this long. An indexing attempt
     * must commit its rows within half of it (packages/face `recordFacesDeadline`), so set it to
     * at least 2 × the longest indexPhoto attempt (every IndexFaces and DeleteFaces call with all
     * retries, rate-limit waits and request timeouts, plus processing). 1 minute to 24 hours;
     * default 3 hours: infra's worst case for one faces job is 3960 s, so 2× that (7,920,000 ms,
     * which infra's synth enforces) rounded up.
     */
    orphanGraceMs: number;
  };
  /** Re-encoding of index images and selfies that are over their byte limit. */
  encode: {
    /** JPEG quality is lowered by this much per attempt. */
    qualityStep: number;
    /** JPEG quality is never lowered below this. */
    minQuality: number;
    /** Each shrink multiplies the long edge by this factor. */
    shrinkFactor: number;
    /** The long edge is never shrunk below this. At most `selfie.longEdge` and `index.longEdge`. */
    minLongEdge: number;
  };
  rekognition: {
    region: string;
    /** Token buckets in Redis, shared by every API and worker instance. */
    rateLimit: {
      /** Prefix of the Redis keys that hold the buckets. */
      keyPrefix: string;
      /**
       * In (0, 1]. An idle bucket lets max(1, floor(tps × min(burstSeconds, 1))) calls start at
       * once; no 1-second window holds more than floor(tps) calls. 1 (the default) allows the
       * whole second's quota at once.
       */
      burstSeconds: number;
      /**
       * Calls per second for each operation, whole numbers from 1 to 1000. Keep each at or under
       * the account's quota for that operation in the region.
       */
      tps: {
        indexFaces: number;
        searchFacesByImage: number;
        searchFaces: number;
        deleteFaces: number;
        /** ListFaces, used only by orphan reconciliation. It has its own quota. */
        listFaces: number;
        /** CreateCollection, DescribeCollection and DeleteCollection. */
        collection: number;
      };
    };
    /**
     * Upper bound on one Rekognition HTTP request (the SDK client's request timeout), in ms. Both
     * profiles use it; infra's faces queue visibility floor counts it once per attempt.
     */
    requestTimeoutMs: number;
    /**
     * Worker profile (indexing, purges). Retries back off from `retryBaseMs` up to `retryMaxMs`;
     * `maxWaitMs` is the longest one call waits for a rate-limit token.
     */
    background: { maxAttempts: number; retryBaseMs: number; retryMaxMs: number; maxWaitMs: number };
    /** API profile (face search). Same fields as `background`, tuned to fail fast. */
    interactive: {
      maxAttempts: number;
      retryBaseMs: number;
      retryMaxMs: number;
      maxWaitMs: number;
    };
  };
}

export function loadFaceConfig(env: Env): FaceConfig {
  const e = parseEnv(faceEnvSchema, env, 'face');
  return {
    thresholds: { strong: e.FACE_STRONG, maybe: e.FACE_MAYBE },
    search: {
      maxSelfies: e.FACE_MAX_SELFIES,
      expansionSeeds: e.FACE_EXPANSION_SEEDS,
      maxFaces: e.FACE_SEARCH_MAX_FACES,
      qualityFilter: e.FACE_SEARCH_QUALITY_FILTER,
    },
    searchRateLimits: {
      perIp: {
        limit: e.FACE_SEARCH_RATE_PER_IP,
        windowSeconds: e.FACE_SEARCH_RATE_PER_IP_WINDOW_SECONDS,
      },
      perShare: {
        limit: e.FACE_SEARCH_RATE_PER_SHARE,
        windowSeconds: e.FACE_SEARCH_RATE_PER_SHARE_WINDOW_SECONDS,
      },
      perViewer: {
        limit: e.FACE_SEARCH_RATE_PER_VIEWER,
        windowSeconds: e.FACE_SEARCH_RATE_PER_VIEWER_WINDOW_SECONDS,
      },
    },
    selfie: { longEdge: e.FACE_SELFIE_LONG_EDGE, jpegQuality: e.FACE_SELFIE_JPEG_QUALITY },
    index: {
      longEdge: e.FACE_INDEX_LONG_EDGE,
      jpegQuality: e.FACE_INDEX_JPEG_QUALITY,
      maxBytes: e.FACE_INDEX_MAX_BYTES,
      maxFaces: e.FACE_INDEX_MAX_FACES,
      qualityFilter: e.FACE_INDEX_QUALITY_FILTER,
      tiling: e.FACE_INDEX_TILING,
      tileGrid: e.FACE_TILE_GRID,
      tileOverlap: e.FACE_TILE_OVERLAP,
      tileEdgeEpsilon: e.FACE_TILE_EDGE_EPSILON,
      smallFaceRatio: e.FACE_SMALL_FACE_RATIO,
      dedupeIou: e.FACE_DEDUPE_IOU,
      orphanGraceMs: e.FACE_ORPHAN_GRACE_MS,
    },
    encode: {
      qualityStep: e.FACE_ENCODE_QUALITY_STEP,
      minQuality: e.FACE_ENCODE_MIN_QUALITY,
      shrinkFactor: e.FACE_ENCODE_SHRINK_FACTOR,
      minLongEdge: e.FACE_ENCODE_MIN_LONG_EDGE,
    },
    rekognition: {
      region: e.AWS_REGION,
      rateLimit: {
        keyPrefix: e.FACE_REKOGNITION_RATE_LIMIT_PREFIX,
        burstSeconds: e.FACE_REKOGNITION_BURST_SECONDS,
        tps: {
          indexFaces: e.FACE_REKOGNITION_TPS_INDEX_FACES,
          searchFacesByImage: e.FACE_REKOGNITION_TPS_SEARCH_FACES_BY_IMAGE,
          searchFaces: e.FACE_REKOGNITION_TPS_SEARCH_FACES,
          deleteFaces: e.FACE_REKOGNITION_TPS_DELETE_FACES,
          listFaces: e.FACE_REKOGNITION_TPS_LIST_FACES,
          collection: e.FACE_REKOGNITION_TPS_COLLECTION,
        },
      },
      requestTimeoutMs: e.FACE_REKOGNITION_REQUEST_TIMEOUT_MS,
      background: {
        maxAttempts: e.FACE_REKOGNITION_MAX_ATTEMPTS,
        retryBaseMs: e.FACE_REKOGNITION_RETRY_BASE_MS,
        retryMaxMs: e.FACE_REKOGNITION_RETRY_MAX_MS,
        maxWaitMs: e.FACE_REKOGNITION_MAX_WAIT_MS,
      },
      interactive: {
        maxAttempts: e.FACE_REKOGNITION_INTERACTIVE_MAX_ATTEMPTS,
        retryBaseMs: e.FACE_REKOGNITION_INTERACTIVE_RETRY_BASE_MS,
        retryMaxMs: e.FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS,
        maxWaitMs: e.FACE_REKOGNITION_INTERACTIVE_MAX_WAIT_MS,
      },
    },
  };
}

/** Rekognition's limit on an image passed as bytes (SearchFacesByImage with a selfie). */
export const REKOGNITION_INLINE_IMAGE_MAX_BYTES = 5 * MiB;

const faceSearchUploadEnvSchema = z
  .object({
    FACE_SEARCH_MAX_SELFIE_BYTES: int(1, REKOGNITION_INLINE_IMAGE_MAX_BYTES),
    FACE_SEARCH_MAX_BODY_BYTES: int(1, 100 * MiB),
  })
  .refine((e) => e.FACE_SEARCH_MAX_SELFIE_BYTES <= e.FACE_SEARCH_MAX_BODY_BYTES, {
    error: 'FACE_SEARCH_MAX_SELFIE_BYTES must be less than or equal to FACE_SEARCH_MAX_BODY_BYTES',
  });

/** Size limits of `POST /s/:token/face-search`, enforced by the API while it reads the body. */
export interface FaceSearchUploadConfig {
  /** Largest selfie part accepted. At most Rekognition's 5 MiB inline image limit. */
  maxSelfieBytes: number;
  /** Largest request body (every selfie plus multipart overhead). The WAF enforces the same. */
  maxBodyBytes: number;
}

/**
 * Reads FACE_SEARCH_MAX_SELFIE_BYTES and FACE_SEARCH_MAX_BODY_BYTES (api only). Both are
 * required: infra derives them from the FACE_* settings (infra/lib/face-limits.ts) and the WAF
 * body rule uses the same numbers, so a default here could silently disagree with the WAF. The
 * body must fit FACE_MAX_SELFIES selfies of the maximum size.
 */
export function loadFaceSearchUploadConfig(env: Env): FaceSearchUploadConfig {
  const e = parseEnv(faceSearchUploadEnvSchema, env, 'face search upload');
  const { maxSelfies } = loadFaceConfig(env).search;
  if (e.FACE_SEARCH_MAX_BODY_BYTES < maxSelfies * e.FACE_SEARCH_MAX_SELFIE_BYTES) {
    throw new Error(
      'Invalid face search upload configuration: FACE_SEARCH_MAX_BODY_BYTES must fit FACE_MAX_SELFIES × FACE_SEARCH_MAX_SELFIE_BYTES',
    );
  }
  return {
    maxSelfieBytes: e.FACE_SEARCH_MAX_SELFIE_BYTES,
    maxBodyBytes: e.FACE_SEARCH_MAX_BODY_BYTES,
  };
}
