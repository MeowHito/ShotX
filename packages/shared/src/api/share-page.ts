import { z } from 'zod';
import { CONSENT_POLICY_VERSIONS } from '../config/consent';
import { SHARE_PAGE_SIZE_LIMIT, ZIP_MAX_FILES_LIMIT } from '../config/share';
import { CURSOR_MAX_LENGTH } from '../cursor-codec';
import { DOWNLOAD_SIZES, SHARE_MODES, SHARE_TARGET_TYPES, ZIP_JOB_STATUSES } from '../domain';
import { ERROR_CODES, type ErrorCode } from '../errors';
import { MEDIA_KINDS } from '../media-types';
import { shareTokenSchema } from '../share/token';
import { byteCountSchema, idSchema, isoDateTimeSchema, signedUrlSchema } from './common';
import { signedDownloadSchema } from './drive';

/**
 * Public share routes (`/api/s/:token/...`, `/api/zip-jobs/:id`). The browser calls them directly
 * through CloudFront, where WAF rate rules and CAPTCHA protect them; see share/viewer for how the
 * viewer is identified (bearer token, viewer-session cookie, anon cookie) and which cookies the
 * API sets. Every route checks, in order: token (unknown or malformed: NOT_FOUND), availability
 * (SHARE_EXPIRED with a reason), require_login (LOGIN_REQUIRED), password (PASSWORD_REQUIRED),
 * then its own rules. `GET /s/:token` is the exception: it reports the login and password gates as
 * flags so the page can render them.
 *
 * Responses never contain face ids, bounding boxes, similarity scores, S3 URLs or data of other
 * shares. Signed URLs use bucketedExpiry (view TTL for thumbnails and previews, download TTL for
 * downloads), and every response that issues URLs writes an activity event.
 */

export const shareTokenParamsSchema = z.object({ token: shareTokenSchema });

/** One photo or video as the share page shows it. */
export const shareItemSchema = z.object({
  id: idSchema,
  /** Display name (shown in the lightbox and used for downloads). */
  name: z.string(),
  mediaKind: z.enum(MEDIA_KINDS),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  takenAt: isoDateTimeSchema.nullable(),
  /** thumb.webp (400 px). */
  thumbUrl: signedUrlSchema,
  /** preview.webp (images) or preview.mp4 (videos). */
  previewUrl: signedUrlSchema,
  /** poster.jpg (videos only). */
  posterUrl: signedUrlSchema.optional(),
  /** When the URLs above stop working: fetch the page again after it. */
  urlsExpireAt: isoDateTimeSchema,
});
export type ShareItem = z.output<typeof shareItemSchema>;

// --- GET /s/:token ------------------------------------------------------------------------------

/**
 * Share meta for the page and its SSR OG tags. Available to anyone with the token (after
 * NOT_FOUND / SHARE_EXPIRED); what is withheld until the gates pass is null.
 */
export const shareMetaResponseSchema = z.object({
  token: shareTokenSchema,
  targetType: z.enum(SHARE_TARGET_TYPES),
  mode: z.enum(SHARE_MODES),
  allowDownload: z.boolean(),
  downloadSize: z.enum(DOWNLOAD_SIZES),
  requireLogin: z.boolean(),
  passwordProtected: z.boolean(),
  expiresAt: isoDateTimeSchema.nullable(),
  /** For this request: what the page must ask for before showing anything. */
  access: z.object({
    /** require_login and no signed-in viewer: show the LINE/Google sign-in. */
    loginRequired: z.boolean(),
    /** Password share not unlocked by this browser: show the password form. */
    locked: z.boolean(),
  }),
  /**
   * Null until both gates pass. `title` is the shared folder's or file's name; `photographerName`
   * the owner's display name (may be null).
   */
  details: z
    .object({
      title: z.string(),
      photographerName: z.string().nullable(),
      /** Ready files in scope; null in face_only mode (it would describe other people's photos). */
      itemCount: z.number().int().nonnegative().nullable(),
      /**
       * OG image and header: the preview of the first ready image in scope (items order). Always
       * null in face_only mode, which shows nobody's photo to everyone.
       */
      cover: z
        .object({
          previewUrl: signedUrlSchema,
          width: z.number().int().positive().nullable(),
          height: z.number().int().positive().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  faceSearch: z.object({
    /**
     * FACE_SEARCH_ENABLED and the share supports it (faceSearchUnavailableReason is null). When
     * false the page hides scanning and "ขอลบใบหน้าของฉัน".
     */
    available: z.boolean(),
    /** The consent text version to show (web i18n key); null when not available. */
    policyVersion: z.enum(CONSENT_POLICY_VERSIONS).nullable(),
    /** This viewer or session has a current, not withdrawn consent for this share. */
    consented: z.boolean(),
  }),
});
export type ShareMetaResponse = z.output<typeof shareMetaResponseSchema>;

// --- GET /s/:token/items ------------------------------------------------------------------------

/**
 * One page of the share's items: ready, live files in scope, ordered by
 * (coalesce(taken_at, created_at), id) ascending. In face_only mode only files in the viewer's
 * face-search result (an empty page without one). `limit` defaults to SHARE_PAGE_SIZE (~100).
 */
export const shareItemsQuerySchema = z.object({
  cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(SHARE_PAGE_SIZE_LIMIT).optional(),
});
export type ShareItemsQuery = z.input<typeof shareItemsQuerySchema>;

/**
 * Cursor of `GET /s/:token/items` (opaque to clients). `key` is the last item's
 * `coalesce(taken_at, created_at)` as PostgreSQL timestamptz text (full microseconds; a JavaScript
 * Date would truncate it and break the keyset). A cursor of another share or a malformed one is
 * VALIDATION_FAILED.
 */
export const shareItemsCursorSchema = z.object({
  v: z.literal(1),
  shareId: idSchema,
  key: z.string().min(1).max(64),
  id: idSchema,
});
export type ShareItemsCursor = z.output<typeof shareItemsCursorSchema>;

export const shareItemsResponseSchema = z.object({
  items: z.array(shareItemSchema),
  nextCursor: z.string().nullable(),
});
export type ShareItemsResponse = z.output<typeof shareItemsResponseSchema>;

// --- POST /s/:token/unlock ----------------------------------------------------------------------

/**
 * 204 with the share's unlock cookie (shareUnlockCookie) on the right password, PASSWORD_INCORRECT
 * otherwise. Rate-limited per IP and share (SHARE_UNLOCK_RATE_PER_IP). On a share without a
 * password it is a 204 no-op. Checked after require_login.
 */
export const unlockShareBodySchema = z.strictObject({ password: z.string().min(1).max(256) });
export type UnlockShareBody = z.input<typeof unlockShareBodySchema>;

// --- POST /s/:token/consent, DELETE /s/:token/consent -------------------------------------------

/**
 * Accept the face-search consent text of `policyVersion` for this share, as this viewer or
 * session. A version other than CONSENT_POLICY_VERSION is CONSENT_VERSION_MISMATCH. Idempotent:
 * an existing current consent is returned as is. Stores `ip_hash`, never the address.
 *
 * DELETE withdraws (204): sets `withdrawn_at` on this viewer's or session's consents for the share
 * and deletes their face-search result (and so the face_only grant). Idempotent. Withdrawal does
 * not need FACE_SEARCH_ENABLED: it always works.
 */
export const giveConsentBodySchema = z.strictObject({
  policyVersion: z.enum(CONSENT_POLICY_VERSIONS),
  accepted: z.literal(true),
});
export type GiveConsentBody = z.input<typeof giveConsentBodySchema>;

export const consentResponseSchema = z.object({
  policyVersion: z.enum(CONSENT_POLICY_VERSIONS),
  acceptedAt: isoDateTimeSchema,
});
export type ConsentResponse = z.output<typeof consentResponseSchema>;

// --- POST /s/:token/face-search, POST /s/:token/face-deletion (multipart) -----------------------

/**
 * Multipart form of face search and face deletion: 1 to FACE_MAX_SELFIES parts named `selfie`,
 * each a JPEG or PNG of at most FACE_SEARCH_MAX_SELFIE_BYTES, the whole body at most
 * FACE_SEARCH_MAX_BODY_BYTES (loadFaceSearchUploadConfig); no other parts. More parts or another
 * name is VALIDATION_FAILED, another type UNSUPPORTED_FILE_TYPE, too big PAYLOAD_TOO_LARGE. The
 * API streams the body, keeps selfies in memory only and never logs them (docs/TODO-api.md).
 */
export const SELFIE_FIELD_NAME = 'selfie';
export const SELFIE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;

/**
 * Face search. Needs FACE_SEARCH_ENABLED (FEATURE_DISABLED), face search on this share
 * (FACE_SEARCH_UNAVAILABLE) and a current consent (CONSENT_REQUIRED). Rate-limited per IP, share
 * and viewer (FACE_SEARCH_RATE_*). Matches are grouped by file (best similarity), bucketed by
 * FACE_STRONG / FACE_MAYBE, kept to ready live files in scope, merged into the viewer's
 * face-search result in Redis (the face_only grant), and returned best first without scores.
 * No face in any selfie: NO_FACE_DETECTED.
 */
export const faceSearchResponseSchema = z.object({
  /** "ใช่คุณ". */
  strong: z.array(shareItemSchema),
  /** "อาจจะเป็นคุณ". */
  maybe: z.array(shareItemSchema),
  /** Selfies received, and how many had no detectable face (the rest were searched). */
  selfies: z.number().int().positive(),
  selfiesWithoutFace: z.number().int().nonnegative(),
});
export type FaceSearchResponse = z.output<typeof faceSearchResponseSchema>;

/**
 * "ขอลบใบหน้าของฉัน" (202). Same multipart form, gates and rate limits as face search, but not
 * FACE_SEARCH_UNAVAILABLE: it searches the share owner's whole collection, not the share's scope.
 * Faces matching any selfie at or above FACE_DELETION_THRESHOLD (direct matches only) are marked
 * for deletion at once (hidden from every search), recorded in `face_deletions` (counts only), and
 * deleted from the collection and the database by the worker (`delete.faces`). The answer is a
 * count only; nothing about the matched photos is returned.
 */
export const faceDeletionResponseSchema = z.object({
  facesMatched: z.number().int().nonnegative(),
});
export type FaceDeletionResponse = z.output<typeof faceDeletionResponseSchema>;

// --- POST /s/:token/feedback --------------------------------------------------------------------

/**
 * "ไม่ใช่ฉัน" on a face-search hit (204). The API looks the file up in the viewer's face-search
 * result: if it is there, it writes `face_feedback` (share, file, the stored similarity; no
 * viewer, no biometrics) and removes the file from the result (in face_only mode the viewer no
 * longer sees it). A file that isn't in the result is a 204 no-op, so double clicks are harmless.
 * Needs FACE_SEARCH_ENABLED; rate-limited per viewer.
 */
export const faceFeedbackBodySchema = z.strictObject({ fileId: idSchema });
export type FaceFeedbackBody = z.input<typeof faceFeedbackBodySchema>;

// --- POST /s/:token/downloads ---------------------------------------------------------------------

/** Header names are lowercase, as Node exposes them. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Printable ASCII, 1–255 characters (matches `zip_jobs_idempotency_key_format`). A UUID is typical. */
export const idempotencyKeySchema = z.string().regex(/^[!-~]{1,255}$/, {
  error: 'must be 1 to 255 printable ASCII characters',
});

/**
 * Headers of `POST /s/:token/downloads`. `Idempotency-Key` is required when more than one file is
 * requested (else VALIDATION_FAILED at `headers.idempotency-key`) and ignored for one file.
 */
export const downloadsHeadersSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema.optional(),
});

/**
 * Download one file or zip several (distinct ids, at most ZIP_MAX_FILES_LIMIT; the API applies
 * ZIP_MAX_FILES and ZIP_MAX_BYTES: ZIP_TOO_LARGE). DOWNLOAD_NOT_ALLOWED when the share disallows
 * downloads. Every id must be in scope (and, in face_only mode, in the grant): otherwise
 * NOT_FOUND for the whole request. The size is the share's `download_size` (downloadObject).
 */
export const createDownloadBodySchema = z.strictObject({
  fileIds: z
    .array(idSchema)
    .min(1)
    .max(ZIP_MAX_FILES_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'fileIds must be distinct' }),
});
export type CreateDownloadBody = z.input<typeof createDownloadBodySchema>;

/** Statuses of `GET /zip-jobs/:id`: the job's status, or `expired` once its archive is gone. */
export const ZIP_JOB_VIEW_STATUSES = [...ZIP_JOB_STATUSES, 'expired'] as const;
export type ZipJobViewStatus = (typeof ZIP_JOB_VIEW_STATUSES)[number];

export const zipJobViewSchema = z.object({
  id: idSchema,
  status: z.enum(ZIP_JOB_VIEW_STATUSES),
  fileCount: z.number().int().positive(),
  /** Sum of the entries' sizes when requested. */
  totalBytes: byteCountSchema,
  createdAt: isoDateTimeSchema,
  /** `ready` only: a signed URL of the archive (download TTL) and when it stops working. */
  download: signedDownloadSchema.omit({ fileId: true }).nullable(),
  /** `ready` only: when the archive itself is deleted (`zip_jobs.expires_at`). */
  availableUntil: isoDateTimeSchema.nullable(),
  /** `failed` only: why (e.g. NOT_FOUND when files were deleted, INTERNAL_ERROR). */
  errorCode: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]).nullable(),
});
export type ZipJobView = z.output<typeof zipJobViewSchema>;

/**
 * One file: a signed URL with `Content-Disposition: attachment` (download TTL); a `download`
 * activity event. Several: a zip job (`queued`, or the existing job when the Idempotency-Key was
 * used before by the same viewer with the same files; same key, other files or another viewer:
 * IDEMPOTENCY_KEY_REUSED); poll `GET /zip-jobs/:id` every few seconds. On iOS the web app may
 * instead fetch single downloads and use the Web Share API.
 */
export const createDownloadResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), file: signedDownloadSchema }),
  z.object({ kind: z.literal('zip'), job: zipJobViewSchema }),
]);
export type CreateDownloadResponse = z.output<typeof createDownloadResponseSchema>;

// --- GET /zip-jobs/:id ------------------------------------------------------------------------------

/**
 * A zip job of this viewer or session (anyone else's: NOT_FOUND). The share's availability and
 * gates are checked again. The first response that issues the archive's URL writes the job's one
 * `zip` activity event (`UPDATE zip_jobs SET url_issued_at = now() WHERE url_issued_at IS NULL`
 * decides which), so polling doesn't inflate the stats.
 */
export const zipJobResponseSchema = zipJobViewSchema;
export type ZipJobResponse = ZipJobView;
