import { z } from 'zod';
import { CONSENT_POLICY_VERSIONS, consentPolicyVersionSchema } from '../config/consent';
import { SHARE_PAGE_SIZE_LIMIT, ZIP_MAX_FILES_LIMIT } from '../config/share';
import { CURSOR_MAX_LENGTH } from '../cursor-codec';
import { designDocSchema } from '../design/doc';
import {
  CONSENT_PURPOSES,
  DOWNLOAD_SIZES,
  SHARE_MODES,
  SHARE_TARGET_TYPES,
  ZIP_JOB_STATUSES,
} from '../domain';
import { ERROR_CODES, type ErrorCode } from '../errors';
import { MEDIA_KINDS } from '../media-types';
import { SUPPORTED_LOCALES } from '../locale';
import { shareRefSchema, shareSlugSchema } from '../share/slug';
import { shareTokenSchema } from '../share/token';
import { byteCountSchema, idSchema, isoDateTimeSchema, signedUrlSchema } from './common';
import { signedDownloadSchema } from './drive';

/**
 * Public share routes (`/api/s/:token/...`, all under the share's path so its unlock cookie,
 * `Path=/api/s/{token}`, reaches every one).
 *
 * Refs (ADR 0011): the `:token` path parameter carries a ref, the share's slug or its token
 * (parseShareRef; the parameter keeps its name so existing callers and controllers don't change).
 * The page URL is `/s/{slug}` (old `/s/{token}` links keep working). The unlock cookie stays
 * scoped to `/api/s/{token}`, so web resolves the page's ref once with `GET /s/:ref` and makes
 * every other call with `meta.token`: a password share unlocked through a slug page then works,
 * and cookie paths never contain percent-encoded Thai. Resolution by slug is rate-limited per IP
 * (SHARE_SLUG_RESOLVE_RATE_PER_IP), and an IP over SHARE_NOT_FOUND_RATE_PER_IP NOT_FOUND answers
 * gets RATE_LIMITED for every slug lookup until the window passes (ADR 0011 risk 3: slugs are
 * guessable). Token lookups are not throttled by these two limits. The browser calls them directly through CloudFront,
 * where WAF rate rules and CAPTCHA protect them; see share/viewer for how the viewer is identified
 * (bearer token, viewer-session cookie, anon cookie) and which cookies the API sets. Every route
 * checks, in order: token (unknown or malformed: NOT_FOUND), availability (SHARE_EXPIRED with a
 * reason), require_login (LOGIN_REQUIRED), password (PASSWORD_REQUIRED), then its own rules.
 * Exceptions:
 * - `GET /s/:token` reports the login and password gates as flags so the page can render them;
 * - consent withdrawal and everything of "ขอลบใบหน้าของฉัน" (the `face_deletion` consent,
 *   `GET` and `POST /s/:token/face-deletion`) check the token only (CONSENT_PURPOSE_GATES).
 *
 * Responses never contain face ids, bounding boxes, similarity scores, S3 URLs or data of other
 * shares. Signed URLs use bucketedExpiry (view TTL for thumbnails and previews, download TTL for
 * downloads). Which routes write which activity events is fixed by PUBLIC_SHARE_ROUTE_ACTIVITY;
 * `GET /s/:token` writes none, although it issues the cover URL.
 */

/** `:token` is a ref (slug or token), see parseShareRef. */
export const shareTokenParamsSchema = z.object({ token: shareRefSchema });

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

/** One ready design image as the share page gets it. */
export const shareDesignAssetSchema = z.object({
  /** Signed CDN URL of web.webp (view TTL, like previews). */
  url: signedUrlSchema,
  /** Of web.webp. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ShareDesignAsset = z.output<typeof shareDesignAssetSchema>;

/**
 * The design of a share page: the document and its `ready` images by asset id (images that are
 * not ready, failed or gone are left out and draw nothing; an image background shows its
 * `color`). The URLs write no activity event, like the cover's.
 */
export const shareMetaDesignSchema = z.object({
  doc: designDocSchema,
  assets: z.record(z.uuid(), shareDesignAssetSchema),
});
export type ShareMetaDesign = z.output<typeof shareMetaDesignSchema>;

/**
 * Share meta for the page and its SSR OG tags. Available to anyone with the token (after
 * NOT_FOUND / SHARE_EXPIRED); what is withheld until the gates pass is null.
 */
export const shareMetaResponseSchema = z.object({
  /**
   * The share's token, whatever ref the request used: web makes every further public call with
   * it (the unlock cookie's path is `/api/s/{token}`). Revealing it to someone who came by slug
   * grants nothing more than the slug does.
   */
  token: shareTokenSchema,
  /**
   * The share's slug (ADR 0011). Null only for a share created by the previous api release
   * during the deploy of migration 0012 (until the follow-up backfill).
   */
  slug: shareSlugSchema.nullable(),
  /**
   * The canonical page path, percent-encoded: sharePublicPath (`/s/{slug}`, or `/s/{token}`
   * without a slug). Web may `replace` a token URL with it and uses it as the canonical URL.
   */
  path: z.string().startsWith('/s/'),
  targetType: z.enum(SHARE_TARGET_TYPES),
  mode: z.enum(SHARE_MODES),
  allowDownload: z.boolean(),
  downloadSize: z.enum(DOWNLOAD_SIZES),
  requireLogin: z.boolean(),
  passwordProtected: z.boolean(),
  expiresAt: isoDateTimeSchema.nullable(),
  /** For this request: what the page must ask for before showing anything. */
  access: z.object({
    /**
     * require_login and no signed-in viewer: show the LINE/Google sign-in (the buttons of
     * GET /auth/providers). When that lists no provider (a share made while one was on), show
     * that sign-in is unavailable instead of empty buttons; the gate still holds.
     */
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
       * OG image and the page's cover (ADR 0011: shown as a 16:3 crop; the crop is display only,
       * the URL is the plain preview.webp). Folder shares: the folder's `cover_file_id` when it
       * is still a live, ready image inside the share scope (the API re-checks on every request;
       * the file may have been moved out, trashed or purged since), else the first ready image
       * in scope (items order). File shares: the file itself when it is an image. Always null in
       * face_only mode, which shows nobody's photo to everyone. width/height are the original's.
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
  /**
   * Face search on this share, plus the API's face settings the scan flow needs. Web reads these
   * from here, never from its own environment, so the client can't disagree with the API.
   */
  faceSearch: z.object({
    /**
     * FACE_SEARCH_ENABLED and the share supports it (faceSearchUnavailableReason is null). When
     * false the page hides scanning. "ขอลบใบหน้าของฉัน" does not depend on it and is not linked
     * from the page (ADR 0011 decision 2; see GET /s/:token/face-deletion).
     */
    available: z.boolean(),
    /** The `face_search` consent text version to show (web i18n key); null when not available. */
    policyVersion: z.enum(CONSENT_POLICY_VERSIONS).nullable(),
    /**
     * This viewer or session has a current, not withdrawn `face_search` consent for this share.
     */
    consented: z.boolean(),
    /** FACE_MAX_SELFIES: angles the client collects at most. */
    maxSelfies: z.number().int().positive(),
    /** FACE_SELFIE_LONG_EDGE: the client downscales each selfie to at most this long edge. */
    selfieLongEdge: z.number().int().positive(),
    /** FACE_SELFIE_JPEG_QUALITY: JPEG quality (1–100) of the downscaled selfie. */
    selfieJpegQuality: z.number().int().min(1).max(100),
    /**
     * SHARE_FACE_ONLY_GRANT_TTL_SECONDS: how long a scan's result (the face_only grant) is kept.
     * The consent text states it.
     */
    resultTtlSeconds: z.number().int().positive(),
  }),
  /**
   * The share page design (ADR 0013): the share's design (`shares.design_id`), else the owner's
   * default design, else null (the plain layout of ADR 0011/0012). Null, like `details`, until
   * both gates pass (a design shows the event's name and logos). Shown in both modes: in a
   * `gallery` share as a full-screen card above the photos, in a `face_only` share as the whole
   * page until a scan; after a scan the card is hidden and the found photos come first.
   */
  design: shareMetaDesignSchema.nullable(),
  /** Zip limits of `POST /s/:token/downloads`. */
  zip: z.object({
    /** ZIP_MAX_FILES: the most files one selection may download. */
    maxFiles: z.number().int().positive(),
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
 * Accept the consent text of `purpose` (default `face_search`) and `policyVersion` for this share,
 * as this viewer or session. Gates depend on the purpose (CONSENT_PURPOSE_GATES):
 * - `face_search`: token, availability, login, password, then FACE_SEARCH_ENABLED
 *   (FEATURE_DISABLED);
 * - `face_deletion`: token only. Works on revoked or expired shares and with the flag off.
 * Then any well-formed version other than CONSENT_POLICY_VERSION is 409 CONSENT_VERSION_MISMATCH
 * with the current version in details. Idempotent per purpose: an existing current consent is
 * returned as is. Stores `ip_hash`, never the address.
 *
 * DELETE withdraws (204): sets `withdrawn_at` on this viewer's or session's consents of every
 * purpose for the share and deletes their face-search result (and so the face_only grant).
 * Idempotent. Token lookup only: it works on revoked or expired shares and with the flag off.
 */
export const giveConsentBodySchema = z.strictObject({
  purpose: z.enum(CONSENT_PURPOSES).default('face_search'),
  policyVersion: consentPolicyVersionSchema,
  /**
   * The language the consent text was shown in (ADR 0011), stored in `consents.locale`. Default
   * `th` (clients from before ADR 0011 only showed Thai). The Thai text is the legal reference;
   * the version is the same in every language.
   */
  locale: z.enum(SUPPORTED_LOCALES).default('th'),
  accepted: z.literal(true),
});
export type GiveConsentBody = z.input<typeof giveConsentBodySchema>;

export const consentResponseSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  policyVersion: z.enum(CONSENT_POLICY_VERSIONS),
  /**
   * The language recorded with the consent. An existing current consent is returned as is, so
   * this is the language of the first acceptance of this version, not necessarily this request's.
   */
  locale: z.enum(SUPPORTED_LOCALES),
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

/**
 * Request header that carries a Turnstile token on face search and face deletion (ADR 0008
 * section 7). A header, not a multipart field, so the api decides before it reads any selfie. It
 * is read only when the request is over a FACE_SEARCH_RATE_* limit (see config/captcha.ts).
 */
export const CAPTCHA_TOKEN_HEADER = 'x-shotx-captcha-token';

/** Longest captcha token accepted (Turnstile tokens are at most 2048 characters). */
export const CAPTCHA_TOKEN_MAX_LENGTH = 2048;

/** A captcha token as the header carries it (printable ASCII). Values are never echoed. */
export const captchaTokenSchema = z
  .string()
  .min(1)
  .max(CAPTCHA_TOKEN_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/, { error: 'must be a captcha token' });

/** Request headers of face search and face deletion: the optional captcha token. */
export const captchaHeadersSchema = z.object({
  [CAPTCHA_TOKEN_HEADER]: captchaTokenSchema.optional(),
});
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
 * "ขอลบใบหน้าของฉัน" (202). Same multipart form and request limits as face search. Gated only on
 * the token (unknown: NOT_FOUND) and a current `face_deletion` consent of this viewer or session
 * for this share (CONSENT_REQUIRED with the current version): never SHARE_EXPIRED, LOGIN_REQUIRED,
 * PASSWORD_REQUIRED, FEATURE_DISABLED or FACE_SEARCH_UNAVAILABLE, so it works on revoked and
 * expired shares and with FACE_SEARCH_ENABLED=false (PDPA data-subject right; ADR 0007). It
 * searches the share owner's whole collection, not the share's scope. Faces matching any selfie at
 * or above FACE_DELETION_THRESHOLD (direct matches only) are marked for deletion at once (hidden
 * from every search), recorded in `face_deletions` (counts only), and deleted from the collection
 * and the database by the worker (`delete.faces`). The answer is a count only; nothing about the
 * matched photos is returned. An owner without a collection answers `facesMatched: 0` without a
 * Rekognition call.
 */
export const faceDeletionResponseSchema = z.object({
  facesMatched: z.number().int().nonnegative(),
});
export type FaceDeletionResponse = z.output<typeof faceDeletionResponseSchema>;

// --- GET /s/:token/face-deletion ----------------------------------------------------------------

/**
 * What the "ขอลบใบหน้าของฉัน" page needs, gated on the ref lookup only, so it works where
 * `GET /s/:token` answers SHARE_EXPIRED or the gates aren't passed. ADR 0011 decision 2: the page
 * (`/s/{ref}/delete-my-face`, shareFaceDeletionPagePath) stays working but is linked from
 * nowhere: not the share page, the consent text, the footer or the "ลิงก์นี้หมดอายุ" page. The
 * company sends the link to a person who asks.
 */
export const faceDeletionInfoResponseSchema = z.object({
  /** The `face_deletion` consent text version to show (CONSENT_POLICY_VERSION). */
  policyVersion: z.enum(CONSENT_POLICY_VERSIONS),
  /** This viewer or session has a current `face_deletion` consent for this share. */
  consented: z.boolean(),
  /** FACE_MAX_SELFIES, FACE_SELFIE_LONG_EDGE and FACE_SELFIE_JPEG_QUALITY, as in share meta. */
  maxSelfies: z.number().int().positive(),
  selfieLongEdge: z.number().int().positive(),
  selfieJpegQuality: z.number().int().min(1).max(100),
});
export type FaceDeletionInfoResponse = z.output<typeof faceDeletionInfoResponseSchema>;

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
 *
 * ADR 0011 results page: "download selected" sends the selected ids, "download all found" the ids
 * of the viewer's face-search result (strong and maybe), the lightbox button one id. The server
 * never trusts that the ids came from a result: in face_only mode they must be in the grant, in
 * gallery mode in scope, as above. More found photos than `meta.zip.maxFiles`: the client splits
 * the selection into several requests (one Idempotency-Key each).
 */
export const createDownloadBodySchema = z.strictObject({
  fileIds: z
    .array(idSchema)
    .min(1)
    .max(ZIP_MAX_FILES_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'fileIds must be distinct' }),
});
export type CreateDownloadBody = z.input<typeof createDownloadBodySchema>;

/**
 * Statuses of `GET /s/:token/zip-jobs/:id`: the job's status, or `expired` once its archive is
 * gone.
 */
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
 * IDEMPOTENCY_KEY_REUSED); poll `GET /s/:token/zip-jobs/:id` every few seconds. On iOS the web app may
 * instead fetch single downloads and use the Web Share API.
 */
export const createDownloadResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), file: signedDownloadSchema }),
  z.object({ kind: z.literal('zip'), job: zipJobViewSchema }),
]);
export type CreateDownloadResponse = z.output<typeof createDownloadResponseSchema>;

// --- GET /s/:token/zip-jobs/:id -------------------------------------------------------------------

/**
 * Params of `GET /s/:token/zip-jobs/:id`. The route lives under the share's path (it used to be
 * `/zip-jobs/:id`) so the share's unlock cookie reaches it and the normal share gates apply.
 */
export const shareZipJobParamsSchema = z.object({ token: shareRefSchema, id: idSchema });

/**
 * A zip job of this share and this viewer or session (another share's or anyone else's job:
 * NOT_FOUND; look it up by `id` AND `share_id` of the token). The share's availability and gates
 * are checked like on every gated route. The first response that issues the archive's URL writes
 * the job's one `zip` activity event (`UPDATE zip_jobs SET url_issued_at = now() WHERE
 * url_issued_at IS NULL` decides which), so polling doesn't inflate the stats.
 */
export const zipJobResponseSchema = zipJobViewSchema;
export type ZipJobResponse = ZipJobView;
