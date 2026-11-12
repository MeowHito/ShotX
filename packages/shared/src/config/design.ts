import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int, KiB, MiB, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './fields';

// Share page designer (ADR 0013). The `_LIMIT` constants are hard ceilings: static zod schemas
// (designDocSchema, the route bodies) and the database use them, and each config value below must
// stay at or under its ceiling. The api checks the configured values on every write
// (checkDesignDocLimits, DESIGN_LIMIT_REACHED, FILE_TOO_LARGE).

/** Longest design name, in characters (`share_designs.name`, ADR 0013: 1..80). */
export const DESIGN_NAME_MAX_LENGTH = 80;

/** Upper bound of DESIGN_MAX_PER_OWNER. */
export const DESIGN_MAX_PER_OWNER_LIMIT = 1000;

/**
 * Upper bound of DESIGN_MAX_ELEMENTS, and the most elements designDocSchema accepts at all.
 */
export const DESIGN_MAX_ELEMENTS_LIMIT = 200;

/**
 * Lower bound of DESIGN_MAX_ELEMENTS: every built-in template (DESIGN_TEMPLATES) fits, so a new
 * design made from one can always be saved.
 */
export const DESIGN_MAX_ELEMENTS_MIN = 20;

/**
 * Upper bound of DESIGN_DOC_MAX_BYTES, and the largest document designDocSchema accepts at all
 * (UTF-8 bytes of JSON.stringify, see designDocByteLength). The database CHECK
 * `share_designs_doc_size` uses it too (on jsonb's text form, which is a little longer).
 */
export const DESIGN_DOC_MAX_BYTES_LIMIT = 256 * KiB;
/**
 * Highest value DESIGN_DOC_MAX_BYTES may be configured to: half the hard ceiling, because the
 * database measures jsonb's text form (`": "`, `", "`), which is longer than JSON.stringify. A
 * document under this limit always fits the database check, so it can't fail with a 500.
 */
export const DESIGN_DOC_MAX_BYTES_CONFIG_MAX = DESIGN_DOC_MAX_BYTES_LIMIT / 2;

/** Upper bound of DESIGN_ASSET_PAGE_SIZE and of the `limit` query of GET /designs/assets. */
export const DESIGN_ASSET_PAGE_SIZE_LIMIT = 200;

/** Upper bound of DESIGN_ASSET_MAX_BYTES. */
export const DESIGN_ASSET_MAX_BYTES_LIMIT = 100 * MiB;

const designEnvSchema = z
  .object({
    /** Designs one photographer may keep; one more is DESIGN_LIMIT_REACHED (ADR 0013: 50). */
    DESIGN_MAX_PER_OWNER: int(1, DESIGN_MAX_PER_OWNER_LIMIT).default(50),
    /** Elements in one document; more is DESIGN_DOC_TOO_LARGE (ADR 0013: 60). */
    DESIGN_MAX_ELEMENTS: int(DESIGN_MAX_ELEMENTS_MIN, DESIGN_MAX_ELEMENTS_LIMIT).default(60),
    /**
     * UTF-8 bytes of one document as JSON (designDocByteLength); more is DESIGN_DOC_TOO_LARGE
     * (ADR 0013: 65536).
     */
    DESIGN_DOC_MAX_BYTES: int(4 * KiB, DESIGN_DOC_MAX_BYTES_CONFIG_MAX).default(64 * KiB),
    /**
     * Largest JSON body of `POST /designs` and `PUT /designs/:id` (the api's body parser for those
     * two routes; every other route keeps API_JSON_BODY_MAX_BYTES, whose 64 KiB default can't
     * carry a full document). At least DESIGN_DOC_MAX_BYTES + 2 KiB (name, revision, keys).
     * Assumption: 96 KiB.
     */
    DESIGN_BODY_MAX_BYTES: int(8 * KiB, DESIGN_DOC_MAX_BYTES_LIMIT + 64 * KiB).default(96 * KiB),
    /** Largest design image upload, in bytes (ADR 0013: 15 MB, read as 15 MiB). */
    DESIGN_ASSET_MAX_BYTES: int(64 * KiB, DESIGN_ASSET_MAX_BYTES_LIMIT).default(15 * MiB),
    /** Long edge of `web.webp` (ADR 0013: 2560). Smaller images are not enlarged. */
    DESIGN_ASSET_LONG_EDGE: int(256, 8192).default(2560),
    /** WebP quality of `web.webp` (alpha is kept lossless). Assumption: 85. */
    DESIGN_ASSET_WEBP_QUALITY: int(1, 100).default(85),
    /**
     * Days an asset stays unreferenced by every design of its owner before the nightly purge
     * deletes it (ADR 0013: 30). Counted from `design_assets.orphaned_at`.
     */
    DESIGN_ASSET_ORPHAN_DAYS: int(1, 3650).default(30),
    /**
     * Lifetime of the presigned PUT URL of `POST /designs/assets`, and of the upload
     * (`design_assets.upload_expires_at`): complete after it is UPLOAD_EXPIRED, and the nightly
     * reconciliation fails the asset and releases its reservation. Assumption: 1 h.
     */
    DESIGN_ASSET_UPLOAD_TTL_SECONDS: int(5 * SECONDS_PER_MINUTE, SECONDS_PER_DAY).default(
      SECONDS_PER_HOUR,
    ),
    /** Items per page of GET /designs/assets (the editor's Uploads panel). Assumption: 60. */
    DESIGN_ASSET_PAGE_SIZE: int(1, DESIGN_ASSET_PAGE_SIZE_LIMIT).default(60),
  })
  .refine((e) => e.DESIGN_BODY_MAX_BYTES >= e.DESIGN_DOC_MAX_BYTES + 2 * KiB, {
    error: 'DESIGN_BODY_MAX_BYTES must be at least DESIGN_DOC_MAX_BYTES + 2048',
  });

export interface DesignAssetConfig {
  /** DESIGN_ASSET_MAX_BYTES: `sizeBytes` of `POST /designs/assets` above it is FILE_TOO_LARGE. */
  maxBytes: number;
  /** DESIGN_ASSET_LONG_EDGE: the worker's `web.webp` long edge. */
  longEdge: number;
  /** DESIGN_ASSET_WEBP_QUALITY. */
  webpQuality: number;
  /** DESIGN_ASSET_ORPHAN_DAYS. */
  orphanDays: number;
  /** DESIGN_ASSET_UPLOAD_TTL_SECONDS. */
  uploadTtlSeconds: number;
  /** DESIGN_ASSET_PAGE_SIZE. */
  pageSize: number;
}

export interface DesignConfig {
  /** DESIGN_MAX_PER_OWNER. */
  maxPerOwner: number;
  /** DESIGN_MAX_ELEMENTS. */
  maxElements: number;
  /** DESIGN_DOC_MAX_BYTES. */
  docMaxBytes: number;
  /** DESIGN_BODY_MAX_BYTES. */
  bodyMaxBytes: number;
  asset: DesignAssetConfig;
}

/**
 * Reads the DESIGN_* settings (ADR 0013). api: every value; worker: `asset` (the design-asset
 * job, the orphan purge and the reconciliation of abandoned uploads).
 */
export function loadDesignConfig(env: Env): DesignConfig {
  const e = parseEnv(designEnvSchema, env, 'design');
  return {
    maxPerOwner: e.DESIGN_MAX_PER_OWNER,
    maxElements: e.DESIGN_MAX_ELEMENTS,
    docMaxBytes: e.DESIGN_DOC_MAX_BYTES,
    bodyMaxBytes: e.DESIGN_BODY_MAX_BYTES,
    asset: {
      maxBytes: e.DESIGN_ASSET_MAX_BYTES,
      longEdge: e.DESIGN_ASSET_LONG_EDGE,
      webpQuality: e.DESIGN_ASSET_WEBP_QUALITY,
      orphanDays: e.DESIGN_ASSET_ORPHAN_DAYS,
      uploadTtlSeconds: e.DESIGN_ASSET_UPLOAD_TTL_SECONDS,
      pageSize: e.DESIGN_ASSET_PAGE_SIZE,
    },
  };
}
