import { z } from 'zod';
import { CURSOR_MAX_LENGTH } from '../cursor-codec';
import { DOWNLOAD_SIZES, SHARE_MODES, SHARE_STATUSES, SHARE_TARGET_TYPES } from '../domain';
import { shareModeAllowedForTarget } from '../share/scope';
import { shareSlugSchema } from '../share/slug';
import { shareTokenSchema } from '../share/token';
import { byteCountSchema, idSchema, isoDateTimeSchema } from './common';

/**
 * Owner share routes (photographer). Shares of other owners are NOT_FOUND. The token is generated
 * by the API (generateShareToken); clients never choose it. So is the slug (ADR 0011): on create
 * the API takes slugifyEventName(shareSlugSourceName(target type, target name)) and inserts
 * shareSlugCandidate(base, attempt) for attempt 0, 1, ... until no unique violation on
 * `shares_slug_unique` (at most SHARE_SLUG_MAX_ATTEMPTS, then INTERNAL_ERROR). The slug never
 * changes afterwards (renaming the target keeps the link) and is never reused. Passwords are sent in plain text over
 * TLS and stored as argon2id hashes; they are never returned.
 */

/** Share passwords: 4 to 128 characters (event PINs are often short; unlock is rate-limited). */
export const SHARE_PASSWORD_MIN_LENGTH = 4;
export const SHARE_PASSWORD_MAX_LENGTH = 128;

export const sharePasswordSchema = z
  .string()
  .min(SHARE_PASSWORD_MIN_LENGTH)
  .max(SHARE_PASSWORD_MAX_LENGTH)
  .refine((p) => p.trim() === p, { error: 'must not start or end with whitespace' });

export const shareTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file'), fileId: idSchema }),
  z.strictObject({ type: z.literal('folder'), folderId: idSchema }),
]);
export type ShareTarget = z.output<typeof shareTargetSchema>;

const settings = {
  mode: z.enum(SHARE_MODES),
  allowDownload: z.boolean(),
  downloadSize: z.enum(DOWNLOAD_SIZES),
  requireLogin: z.boolean(),
  /** null: no password. */
  password: sharePasswordSchema.nullable(),
  /** null: never expires. Must be in the future (else VALIDATION_FAILED). */
  expiresAt: isoDateTimeSchema.nullable(),
  /**
   * The share page design (ADR 0013): one of the caller's designs (else DESIGN_NOT_FOUND), or
   * null: no design (the plain layout). The owner's default design is not applied at view time;
   * the studio preselects it when a share is created.
   */
  designId: idSchema.nullable(),
};

// --- POST /shares -----------------------------------------------------------------------------

/**
 * Create a share of a live file (`ready`) or live folder of the caller. `face_only` needs a folder
 * target, and FACE_SEARCH_ENABLED (else FEATURE_DISABLED). Needs a trial, active or grace
 * subscription (else SUBSCRIPTION_INACTIVE; not checked with BILLING_MODE=offline).
 * `requireLogin: true` needs a viewer sign-in (viewerLoginAvailable: LINE or Google configured,
 * or the dev login), else LOGIN_PROVIDER_UNAVAILABLE (409); AUTH_PROVIDER=cognito skips the check.
 */
export const createShareBodySchema = z
  .strictObject({
    target: shareTargetSchema,
    mode: settings.mode.default('gallery'),
    allowDownload: settings.allowDownload.default(true),
    downloadSize: settings.downloadSize.default('web'),
    requireLogin: settings.requireLogin.default(false),
    password: settings.password.default(null),
    expiresAt: settings.expiresAt.default(null),
    designId: settings.designId.default(null),
  })
  .refine((b) => shareModeAllowedForTarget(b.mode, b.target.type), {
    error: 'face_only shares must target a folder',
    path: ['mode'],
  });
export type CreateShareBody = z.input<typeof createShareBodySchema>;

/** A share as its owner sees it. */
export const ownerShareSchema = z.object({
  id: idSchema,
  token: shareTokenSchema,
  /**
   * The readable ref (ADR 0011). Null only for a share created by the previous api release
   * during the deploy of migration 0012 (until the follow-up backfill).
   */
  slug: shareSlugSchema.nullable(),
  /** sharePublicPath: `/{slug}` percent-encoded, or `/{token}` without a slug (ADR 0015). */
  path: z.string().startsWith('/'),
  /**
   * Absolute link to copy and share: PUBLIC_BASE_URL + `path` (sharePublicUrl). Changed in ADR
   * 0011: it was the token link (shareUrl), which keeps working.
   */
  url: z.url(),
  target: z.object({
    type: z.enum(SHARE_TARGET_TYPES),
    id: idSchema,
    /** Current name of the file or folder. */
    name: z.string(),
    /** True when the target is in the trash or being purged: the link shows "หมดอายุ". */
    unavailable: z.boolean(),
  }),
  mode: z.enum(SHARE_MODES),
  allowDownload: z.boolean(),
  downloadSize: z.enum(DOWNLOAD_SIZES),
  requireLogin: z.boolean(),
  passwordProtected: z.boolean(),
  expiresAt: isoDateTimeSchema.nullable(),
  /**
   * `shares.design_id` (ADR 0013): the chosen design, or null (the owner's default applies at view
   * time). Becomes null when the design is deleted.
   */
  designId: idSchema.nullable(),
  /** ownerShareStatus: `revoked` (is_active false), `expired` (expires_at passed) or `active`. */
  status: z.enum(SHARE_STATUSES),
  createdAt: isoDateTimeSchema,
});
export type OwnerShare = z.output<typeof ownerShareSchema>;

// --- GET /shares --------------------------------------------------------------------------------

export const SHARE_LIST_PAGE_SIZE_LIMIT = 200;

/**
 * The caller's shares, newest first (ORDER BY id DESC: ids are uuidv7), revoked and expired ones
 * included. Filter by target to show a file's or folder's shares in the drive.
 */
export const listSharesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(SHARE_LIST_PAGE_SIZE_LIMIT).optional(),
    fileId: idSchema.optional(),
    folderId: idSchema.optional(),
  })
  .refine((q) => q.fileId === undefined || q.folderId === undefined, {
    error: 'fileId and folderId are exclusive',
  });
export type ListSharesQuery = z.input<typeof listSharesQuerySchema>;

/** Cursor of `GET /shares` (opaque to clients): the last share's id. */
export const shareListCursorSchema = z.object({ v: z.literal(1), id: idSchema });
export type ShareListCursor = z.output<typeof shareListCursorSchema>;

export const listSharesResponseSchema = z.object({
  items: z.array(ownerShareSchema),
  nextCursor: z.string().nullable(),
});
export type ListSharesResponse = z.output<typeof listSharesResponseSchema>;

// --- PATCH /shares/:id ----------------------------------------------------------------------------

/**
 * Change settings of a share that isn't revoked (revoked: CONFLICT). The token, slug and target
 * never change. `password: null` removes the password; a new or removed password locks out everyone who
 * unlocked the old one. Switching to `face_only` follows the create rules. `requireLogin: true`
 * follows the create rule (LOGIN_PROVIDER_UNAVAILABLE without a viewer sign-in), also when the
 * share already requires login; leaving `requireLogin` out or sending `false` is always allowed,
 * so an owner can still edit or relax a `require_login` share made while a provider was on.
 */
export const updateShareBodySchema = z
  .strictObject({
    mode: settings.mode.optional(),
    allowDownload: settings.allowDownload.optional(),
    downloadSize: settings.downloadSize.optional(),
    requireLogin: settings.requireLogin.optional(),
    password: settings.password.optional(),
    expiresAt: settings.expiresAt.optional(),
    designId: settings.designId.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    error: 'at least one setting is required',
  });
export type UpdateShareBody = z.input<typeof updateShareBodySchema>;

// --- DELETE /shares/:id ---------------------------------------------------------------------------
// Revoke (204): sets is_active = false. Final: a revoked share is never re-enabled (create a new
// one); its token is never reused. Revoking twice is a no-op. Face-search results and unlock
// sessions of the share become useless at once (every public route checks availability first).

// --- GET /shares/:id/stats ------------------------------------------------------------------------

/** Longest range of one stats request, in days. */
export const SHARE_STATS_MAX_DAYS = 366;

/** A calendar day in Asia/Bangkok, `YYYY-MM-DD`. */
export const bangkokDateSchema = z.iso.date();

/**
 * Days of `share_daily_stats` (rolled up hourly from activity_events; dashboards never read raw
 * events). Both bounds inclusive; default: the last 30 days up to today (Bangkok). More than
 * SHARE_STATS_MAX_DAYS days, or `from` after `to`, is VALIDATION_FAILED.
 */
export const shareStatsQuerySchema = z
  .object({ from: bangkokDateSchema.optional(), to: bangkokDateSchema.optional() })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    error: 'from must not be after to',
  });
export type ShareStatsQuery = z.input<typeof shareStatsQuerySchema>;

const statCount = z.number().int().nonnegative();

export const shareStatsValuesSchema = z.object({
  /** Distinct viewers or anonymous sessions that loaded a page of the share. */
  visitors: statCount,
  /** Distinct viewers or sessions that scanned. */
  scanners: statCount,
  scans: statCount,
  /** Single-file download URLs issued. */
  downloads: statCount,
  /** Distinct viewers or sessions that downloaded a file or a zip. */
  uniqueDownloaders: statCount,
  /** Zip URLs issued. */
  zips: statCount,
  bytesOut: byteCountSchema,
});
export type ShareStatsValues = z.output<typeof shareStatsValuesSchema>;

export const shareStatsResponseSchema = z.object({
  shareId: idSchema,
  from: bangkokDateSchema,
  to: bangkokDateSchema,
  /**
   * Sums over the days. Distinct counts are summed per day, so a person who came back on another
   * day counts again.
   */
  totals: shareStatsValuesSchema,
  /** One entry per day with activity, ascending; days without activity are omitted. */
  days: z.array(shareStatsValuesSchema.extend({ date: bangkokDateSchema })),
  /**
   * When the newest of the returned days was last rolled up (`share_daily_stats.updated_at`); null
   * when no day has activity. The hourly rollup lags real time by up to about an hour.
   */
  rolledUpAt: isoDateTimeSchema.nullable(),
});
export type ShareStatsResponse = z.output<typeof shareStatsResponseSchema>;
