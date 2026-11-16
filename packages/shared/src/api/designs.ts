import { z } from 'zod';
import { DESIGN_ASSET_PAGE_SIZE_LIMIT, DESIGN_NAME_MAX_LENGTH } from '../config/design';
import { CURSOR_MAX_LENGTH } from '../cursor-codec';
import { DESIGN_ASSET_STATUSES } from '../design/assets';
import { designDocSchema } from '../design/doc';
import { DESIGN_TEMPLATE_IDS } from '../design/templates';
import { DEFAULT_LOCALE, supportedLocaleSchema } from '../locale';
import { originalNameSchema } from '../s3-keys';
import { byteCountSchema, idSchema, isoDateTimeSchema, signedUrlSchema } from './common';

/**
 * Share page designs (ADR 0013), photographer only. Every route is owner-scoped: the guard plus
 * `owner_id` in every query; another owner's design or image is NOT_FOUND. Documents are
 * validated with designDocSchema, then against the configured limits (checkDesignDocLimits:
 * DESIGN_DOC_TOO_LARGE), then every asset id they reference (designDocAssetIds) must be one of
 * the caller's `design_assets` rows that is not purge-requested, in any status
 * (DESIGN_ASSET_NOT_FOUND otherwise; the rows are locked FOR KEY SHARE in the write's
 * transaction, see the orphan purge in SCHEDULED_JOB_TYPES `trash.purge.daily`).
 *
 * The bodies of `POST /designs` and `PUT /designs/:id` may be up to DESIGN_BODY_MAX_BYTES (the
 * other routes keep API_JSON_BODY_MAX_BYTES).
 *
 * Route order (NestJS): register `GET /designs/assets` before `GET /designs/:id`, or `assets`
 * is taken for an id (VALIDATION_FAILED).
 */

/** A design's name: 1 to 80 characters after trimming, no control characters. */
export const designNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(DESIGN_NAME_MAX_LENGTH)
  .refine((name) => !/[\p{Cc}\p{Cs}]/u.test(name), {
    error: 'must not contain control characters',
  });

// --- Design images ------------------------------------------------------------------------------

/** A design image as its owner sees it (editor, uploads panel). */
export const designAssetViewSchema = z.object({
  id: idSchema,
  status: z.enum(DESIGN_ASSET_STATUSES),
  mime: z.string(),
  /** Of the original upload (what storage_usage counts). */
  sizeBytes: byteCountSchema,
  /** Of web.webp; null until `ready`. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Signed CDN URL of web.webp (view TTL); null until `ready`. Never an S3 URL. */
  url: signedUrlSchema.nullable(),
  /** When `url` stops working; null without a URL. */
  urlExpiresAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type DesignAssetView = z.output<typeof designAssetViewSchema>;

/**
 * The images documents reference, by asset id: each referenced id the caller owns (not
 * purge-requested), any status. Ids missing here draw nothing.
 */
export const designAssetMapSchema = z.record(z.uuid(), designAssetViewSchema);
export type DesignAssetMap = z.output<typeof designAssetMapSchema>;

// --- Designs ------------------------------------------------------------------------------------

/** A design with its document (GET /designs/:id, POST /designs, PUT /designs/:id). */
export const designSchema = z.object({
  id: idSchema,
  name: designNameSchema,
  /** At most one design per owner is the default (links without a design use it). */
  isDefault: z.boolean(),
  /** Optimistic concurrency: send it back with the next PUT. Starts at 1. */
  revision: z.number().int().positive(),
  doc: designDocSchema,
  /** The images `doc` references (designAssetMapSchema). */
  assets: designAssetMapSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Design = z.output<typeof designSchema>;

/** One design in the list: everything but the asset map (the list has one map for all). */
export const designSummarySchema = designSchema.omit({ assets: true });
export type DesignSummary = z.output<typeof designSummarySchema>;

/** The configured limits the studio shows and checks before saving or uploading. */
export const designLimitsSchema = z.object({
  /** DESIGN_MAX_PER_OWNER. */
  maxDesigns: z.number().int().positive(),
  /** DESIGN_MAX_ELEMENTS. */
  maxElements: z.number().int().positive(),
  /** DESIGN_DOC_MAX_BYTES (designDocByteLength). */
  docMaxBytes: z.number().int().positive(),
  /** DESIGN_ASSET_MAX_BYTES. */
  assetMaxBytes: z.number().int().positive(),
});
export type DesignLimits = z.output<typeof designLimitsSchema>;

// GET /designs

/**
 * Every design of the caller (at most DESIGN_MAX_PER_OWNER, so no pagination), most recently
 * updated first, with their documents for the live mini previews and one asset map for them all.
 */
export const listDesignsResponseSchema = z.object({
  items: z.array(designSummarySchema),
  assets: designAssetMapSchema,
  limits: designLimitsSchema,
});
export type ListDesignsResponse = z.output<typeof listDesignsResponseSchema>;

// POST /designs

/**
 * Create a design: from a template (`templateId`, with placeholder text in `locale`, default
 * Thai: designTemplateDoc), from a document (`doc`, e.g. a duplicate), or blank (neither:
 * blankDesignDoc); revision 1. The default when the owner has no default design (ADR 0028). DESIGN_LIMIT_REACHED at DESIGN_MAX_PER_OWNER
 * designs (counted in the insert's transaction under a per-owner lock, so two creates can't both
 * pass).
 */
export const createDesignBodySchema = z
  .strictObject({
    name: designNameSchema,
    templateId: z.enum(DESIGN_TEMPLATE_IDS).optional(),
    doc: designDocSchema.optional(),
    /** The template's placeholder language; ignored without `templateId`. */
    locale: supportedLocaleSchema.default(DEFAULT_LOCALE),
  })
  .refine((b) => b.templateId === undefined || b.doc === undefined, {
    error: 'templateId and doc are exclusive',
    path: ['doc'],
  });
export type CreateDesignBody = z.input<typeof createDesignBodySchema>;

// PUT /designs/:id

/**
 * Save (autosave and rename). `revision` is the revision the editor started from: it must equal
 * the stored one, else DESIGN_REVISION_CONFLICT and nothing changes (UPDATE ... WHERE revision =
 * $revision). The response has revision + 1 and the new `updatedAt`. `isDefault` is not changed
 * here.
 */
export const updateDesignBodySchema = z.strictObject({
  name: designNameSchema,
  doc: designDocSchema,
  revision: z.number().int().positive(),
});
export type UpdateDesignBody = z.input<typeof updateDesignBodySchema>;

// DELETE /designs/:id (204): hard delete. `shares.design_id` of its links becomes null (the
// foreign key's ON DELETE SET NULL), so they follow the owner's default from then on; deleting the
// default leaves the owner without one. Its images are kept (the orphan purge decides).

// POST /designs/:id/default (204): make it the default; clears the previous default in the same
// transaction (clear first, then set, so the partial unique index never sees two). Idempotent.

// DELETE /designs/:id/default (204, added): the owner has no default any more if this design was
// it; a no-op otherwise.

// --- Design image routes ------------------------------------------------------------------------

// POST /designs/assets

/**
 * Start a design image upload: checks the name and MIME pair (designAssetFileType, else
 * UNSUPPORTED_FILE_TYPE with UnsupportedFileTypeDetails), `sizeBytes` against
 * DESIGN_ASSET_MAX_BYTES (FILE_TOO_LARGE), reserves the bytes like uploads (QUOTA_EXCEEDED only
 * with STORAGE_QUOTA_ENFORCED), inserts the `design_assets` row (`uploading`, `upload_expires_at`
 * = now + DESIGN_ASSET_UPLOAD_TTL_SECONDS) and presigns one PUT of
 * designAssetKey(..., 'original'). The file name is only used for the type check; it is not
 * stored.
 */
export const createDesignAssetBodySchema = z.strictObject({
  fileName: originalNameSchema,
  /** Declared MIME type (checked with the extension, not here, so clients get the code). */
  mime: z.string().min(1).max(255),
  /** Exact size in bytes; the presigned PUT signs it and the worker checks it. */
  sizeBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type CreateDesignAssetBody = z.input<typeof createDesignAssetBodySchema>;

export const createDesignAssetResponseSchema = z.object({
  assetId: idSchema,
  /**
   * Presigned PUT URL straight to the bucket (the bytes never pass through the API): one of the
   * two kinds of storage URL the API hands out, with multipart part URLs.
   */
  uploadUrl: z.url(),
  /** Headers the PUT must send exactly as given (e.g. Content-Type); they are signed. */
  headers: z.record(z.string(), z.string()),
  /** When the URL and the upload expire (complete after it is UPLOAD_EXPIRED). */
  expiresAt: isoDateTimeSchema,
});
export type CreateDesignAssetResponse = z.output<typeof createDesignAssetResponseSchema>;

// POST /designs/assets/:id/complete

/**
 * After the PUT: `uploading` -> `processing` with `queued_at` set, in one guarded UPDATE, then
 * send `design.asset` (designAssetMessageSchema). Idempotent: an asset already `processing` or
 * `ready` answers its current state and sends nothing. `failed` or purge-requested is CONFLICT;
 * past `upload_expires_at` is UPLOAD_EXPIRED. No body; the response is the asset
 * (designAssetViewSchema). The worker verifies the bytes; poll GET /designs/assets/:id.
 */

// GET /designs/assets/:id: the asset (designAssetViewSchema). Purge-requested ones are NOT_FOUND.

// GET /designs/assets (added: the editor's Uploads panel, to reuse earlier images)

/**
 * The caller's design images, newest first (ORDER BY id DESC: uuidv7), purge-requested ones and
 * `failed` ones left out. `limit` defaults to DESIGN_ASSET_PAGE_SIZE.
 */
export const listDesignAssetsQuerySchema = z.object({
  cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(DESIGN_ASSET_PAGE_SIZE_LIMIT).optional(),
});
export type ListDesignAssetsQuery = z.input<typeof listDesignAssetsQuerySchema>;

/** Cursor of GET /designs/assets (opaque to clients): the last asset's id. */
export const designAssetListCursorSchema = z.object({ v: z.literal(1), id: idSchema });
export type DesignAssetListCursor = z.output<typeof designAssetListCursorSchema>;

export const listDesignAssetsResponseSchema = z.object({
  items: z.array(designAssetViewSchema),
  nextCursor: z.string().nullable(),
});
export type ListDesignAssetsResponse = z.output<typeof listDesignAssetsResponseSchema>;
