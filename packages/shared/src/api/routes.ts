import type { z } from 'zod';
import type { ActivityType } from '../domain';
import { ErrorCode } from '../errors';
import {
  adminLoginBodySchema,
  adminLoginResponseSchema,
  adminMfaBodySchema,
  authProvidersResponseSchema,
  authTokenResponseSchema,
  devLoginBodySchema,
  logoutBodySchema,
  oidcCallbackBodySchema,
  oidcProviderParamsSchema,
  oidcStartBodySchema,
  oidcStartResponseSchema,
  refreshBodySchema,
} from './auth';
import {
  checkoutHeadersSchema,
  checkoutResponseSchema,
  createCheckoutBodySchema,
  paymentViewSchema,
  plansResponseSchema,
  subscriptionResponseSchema,
  webhookParamsSchema,
  webhookResponseSchema,
} from './billing';
import { API_PREFIX, idParamsSchema } from './common';
import {
  createFolderBodySchema,
  ownerDownloadQuerySchema,
  signedDownloadSchema,
  updateFaceIndexBodySchema,
  driveFileSchema,
  driveFolderSchema,
  driveItemsBodySchema,
  driveUsageResponseSchema,
  emptyTrashResponseSchema,
  listChildrenParamsSchema,
  listChildrenQuerySchema,
  listChildrenResponseSchema,
  listTrashQuerySchema,
  listTrashResponseSchema,
  restoreItemsResponseSchema,
  trashItemsResponseSchema,
  updateFileBodySchema,
  updateFolderBodySchema,
} from './drive';
import { becomePhotographerBodySchema, meResponseSchema } from './me';
import {
  consentResponseSchema,
  createDownloadBodySchema,
  createDownloadResponseSchema,
  downloadsHeadersSchema,
  faceDeletionInfoResponseSchema,
  faceDeletionResponseSchema,
  faceFeedbackBodySchema,
  faceSearchResponseSchema,
  giveConsentBodySchema,
  SELFIE_FIELD_NAME,
  SELFIE_MIME_TYPES,
  shareItemsQuerySchema,
  shareItemsResponseSchema,
  shareMetaResponseSchema,
  shareTokenParamsSchema,
  shareZipJobParamsSchema,
  unlockShareBodySchema,
  zipJobResponseSchema,
} from './share-page';
import {
  createShareBodySchema,
  listSharesQuerySchema,
  listSharesResponseSchema,
  ownerShareSchema,
  shareStatsQuerySchema,
  shareStatsResponseSchema,
  updateShareBodySchema,
} from './shares';
import {
  completeUploadBodySchema,
  completeUploadResponseSchema,
  listPartsResponseSchema,
  signPartsBodySchema,
  signPartsResponseSchema,
  uploadInitBodySchema,
  uploadInitResponseSchema,
} from './uploads';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Who may call a route:
 * - `photographer`: a users-pool token of a user with role `photographer` (via the web BFF);
 * - `user`: any users-pool token (role `user` or `photographer`); the guard provisions the
 *   `users` row on first use (newUserForIdentity);
 * - `public`: no token needed; called by the browser directly at `/api/...` through CloudFront and
 *   the WAF, not through the BFF. The viewer is resolved as described in share/viewer (optional
 *   bearer token, viewer-session cookie, anon cookie). State-changing public requests from another
 *   origin (Origin header) are FORBIDDEN.
 * - `webhook`: server-to-server calls from a payment gateway. No token, no cookies, no Origin
 *   check, not behind the WAF's share rules; the body is read raw and the gateway adapter verifies
 *   its signature before anything is parsed (WEBHOOK_SIGNATURE_INVALID).
 * - `bff`: sign-in routes (AUTH_ROUTES, AUTH_PROVIDER=shotx or local). No user token: called
 *   server-side by the web and admin BFFs only, with the shared key in BFF_KEY_HEADER required
 *   (missing or wrong: UNAUTHENTICATED). Never proxied from the browser (the web's generic `/bff`
 *   proxy must refuse them like `public` and `webhook`), no cookies, no Origin check.
 * Every server-side call from web or admin (any RouteAuth) sends BFF_KEY_HEADER and the end
 * user's IP in BFF_CLIENT_IP_HEADER; the API trusts that IP only with a valid key.
 * Admins (admins-pool tokens) use only `/admin/*` routes; anywhere else they are UNAUTHENTICATED.
 * Admins-pool tokens without `otp` in `amr` are MFA_REQUIRED on admin routes (ADMIN_REQUIRED_AMR).
 */
export type RouteAuth = 'photographer' | 'user' | 'public' | 'webhook' | 'bff';

/** A multipart/form-data request body of file parts only. */
export interface MultipartSpec {
  /** Name of the (repeatable) file part. */
  fileField: string;
  /** Accepted part content types; anything else is UNSUPPORTED_FILE_TYPE. */
  mimeTypes: readonly string[];
  /** Config key of the most parts accepted; more is VALIDATION_FAILED. */
  maxFilesConfigKey: string;
}

/**
 * One API route: everything api (NestJS controllers and zod pipes), web (the client) and the
 * OpenAPI generator need. `path` is relative to {@link API_PREFIX} in NestJS syntax (`:id`).
 * Validation failures of params, query, headers or body are VALIDATION_FAILED with
 * `validationFailedDetails`.
 */
export interface RouteContract {
  method: HttpMethod;
  path: string;
  /** Status of a successful response. 204 has no body. */
  status: 200 | 201 | 202 | 204;
  auth: RouteAuth;
  params?: z.ZodType;
  query?: z.ZodType;
  /** Request headers the route reads, by lowercase name (other headers are ignored). */
  headers?: z.ZodType;
  /** JSON request body. */
  body?: z.ZodType;
  /** Instead of `body`: a multipart/form-data body. */
  multipart?: MultipartSpec;
  /**
   * Instead of `body`: the exact request bytes, unparsed (signature verification). At most
   * API_JSON_BODY_MAX_BYTES (PAYLOAD_TOO_LARGE).
   */
  rawBody?: true;
  /** Absent for 204. */
  response?: z.ZodType;
  /** Every error code the route can return. */
  errors: readonly ErrorCode[];
}

/** Errors every authenticated route can return. */
export const COMMON_ROUTE_ERRORS = [
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.FORBIDDEN,
  ErrorCode.RATE_LIMITED,
  ErrorCode.INTERNAL_ERROR,
] as const;

const errors = (...specific: ErrorCode[]): readonly ErrorCode[] => [
  ...COMMON_ROUTE_ERRORS,
  ...specific,
];

/** Drive routes (Phase 2). Items of other owners are NOT_FOUND. */
export const DRIVE_ROUTES = {
  /** One page of a folder's live children, folders first. `:id` is a folder id or `root`. */
  listChildren: {
    method: 'GET',
    path: '/drive/folders/:id/children',
    status: 200,
    auth: 'photographer',
    params: listChildrenParamsSchema,
    query: listChildrenQuerySchema,
    response: listChildrenResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  createFolder: {
    method: 'POST',
    path: '/drive/folders',
    status: 201,
    auth: 'photographer',
    body: createFolderBodySchema,
    response: driveFolderSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.NAME_TAKEN, ErrorCode.FOLDER_DEPTH_EXCEEDED),
  },
  /** Rename and/or move a folder (with its subtree). */
  updateFolder: {
    method: 'PATCH',
    path: '/drive/folders/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateFolderBodySchema,
    response: driveFolderSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.NAME_TAKEN,
      ErrorCode.INVALID_MOVE,
      ErrorCode.FOLDER_DEPTH_EXCEEDED,
    ),
  },
  /** Rename and/or move a file. */
  updateFile: {
    method: 'PATCH',
    path: '/drive/files/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateFileBodySchema,
    response: driveFileSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.NAME_TAKEN, ErrorCode.UNSUPPORTED_FILE_TYPE),
  },
  trashItems: {
    method: 'POST',
    path: '/drive/items/trash',
    status: 200,
    auth: 'photographer',
    body: driveItemsBodySchema,
    response: trashItemsResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  restoreItems: {
    method: 'POST',
    path: '/drive/items/restore',
    status: 200,
    auth: 'photographer',
    body: driveItemsBodySchema,
    response: restoreItemsResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  /** Added (not in the spec's route list): the trash view needs a listing. */
  listTrash: {
    method: 'GET',
    path: '/drive/trash',
    status: 200,
    auth: 'photographer',
    query: listTrashQuerySchema,
    response: listTrashResponseSchema,
    errors: errors(),
  },
  emptyTrash: {
    method: 'DELETE',
    path: '/drive/trash',
    status: 202,
    auth: 'photographer',
    response: emptyTrashResponseSchema,
    errors: errors(),
  },
  /**
   * Added (Phase 3): turn face indexing of a folder subtree on (PDPA confirmation required),
   * extend it, or turn it off. See updateFaceIndexBodySchema.
   */
  updateFaceIndex: {
    method: 'PATCH',
    path: '/drive/folders/:id/face-index',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateFaceIndexBodySchema,
    response: driveFolderSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.FEATURE_DISABLED,
      ErrorCode.SUBSCRIPTION_INACTIVE,
    ),
  },
  /** Added (Phase 3): the owner's own download (any subscription status). */
  downloadFile: {
    method: 'GET',
    path: '/drive/files/:id/download',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    query: ownerDownloadQuerySchema,
    response: signedDownloadSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.CONFLICT),
  },
  /** Added (not in the spec's route list): the studio's storage meter. */
  usage: {
    method: 'GET',
    path: '/drive/usage',
    status: 200,
    auth: 'photographer',
    response: driveUsageResponseSchema,
    errors: errors(),
  },
} as const satisfies Record<string, RouteContract>;

/** Upload routes (Phase 2). `:id` is the file id. */
export const UPLOAD_ROUTES = {
  init: {
    method: 'POST',
    path: '/uploads/init',
    status: 201,
    auth: 'photographer',
    body: uploadInitBodySchema,
    response: uploadInitResponseSchema,
    errors: errors(
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      ErrorCode.FILE_TOO_LARGE,
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.NOT_FOUND,
      ErrorCode.NAME_TAKEN,
      ErrorCode.FOLDER_DEPTH_EXCEEDED,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      ErrorCode.CONFLICT,
    ),
  },
  /** Added: presigned URLs for more parts (Uppy `signPart`). */
  signParts: {
    method: 'POST',
    path: '/uploads/:id/parts',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: signPartsBodySchema,
    response: signPartsResponseSchema,
    errors: errors(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  /** Added: parts already uploaded, for resuming (Uppy `listParts`). */
  listParts: {
    method: 'GET',
    path: '/uploads/:id/parts',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: listPartsResponseSchema,
    errors: errors(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  complete: {
    method: 'POST',
    path: '/uploads/:id/complete',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: completeUploadBodySchema,
    response: completeUploadResponseSchema,
    errors: errors(
      ErrorCode.UPLOAD_NOT_FOUND,
      ErrorCode.UPLOAD_EXPIRED,
      ErrorCode.UPLOAD_PARTS_INVALID,
    ),
  },
  /** Abort: S3 AbortMultipartUpload, delete the row, release the reservation. */
  abort: {
    method: 'DELETE',
    path: '/uploads/:id',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: errors(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.CONFLICT),
  },
} as const satisfies Record<string, RouteContract>;

/** The signed-in user (Phase 3). */
export const ME_ROUTES = {
  /** Provisions the `users` row on first use. */
  get: {
    method: 'GET',
    path: '/me',
    status: 200,
    auth: 'user',
    response: meResponseSchema,
    errors: errors(),
  },
  /** Photographer onboarding: role + 14-day trial, idempotent. */
  becomePhotographer: {
    method: 'POST',
    path: '/me/photographer',
    status: 200,
    auth: 'user',
    body: becomePhotographerBodySchema,
    response: meResponseSchema,
    errors: errors(),
  },
  /**
   * Called by the web BFF for a signed-in user before the share page uses the public routes:
   * sets the viewer-session cookie (viewerSessionCookie, Path=/api). The BFF must pass the
   * Set-Cookie header through to the browser.
   */
  createViewerSession: {
    method: 'POST',
    path: '/me/viewer-session',
    status: 204,
    auth: 'user',
    errors: errors(),
  },
  /** Ends the viewer session of the cookie it carries (sign-out) and clears the cookie. */
  deleteViewerSession: {
    method: 'DELETE',
    path: '/me/viewer-session',
    status: 204,
    auth: 'public',
    errors: errors(),
  },
} as const satisfies Record<string, RouteContract>;

/** Owner share routes (Phase 3). Shares of other owners are NOT_FOUND. */
export const SHARE_ROUTES = {
  create: {
    method: 'POST',
    path: '/shares',
    status: 201,
    auth: 'photographer',
    body: createShareBodySchema,
    response: ownerShareSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.FEATURE_DISABLED,
    ),
  },
  /** Added: the studio's share list (optionally of one file or folder). */
  list: {
    method: 'GET',
    path: '/shares',
    status: 200,
    auth: 'photographer',
    query: listSharesQuerySchema,
    response: listSharesResponseSchema,
    errors: errors(),
  },
  /** Added: one share, for its settings page. */
  get: {
    method: 'GET',
    path: '/shares/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: ownerShareSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  /** Change settings; a revoked share is CONFLICT. */
  update: {
    method: 'PATCH',
    path: '/shares/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateShareBodySchema,
    response: ownerShareSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.CONFLICT, ErrorCode.FEATURE_DISABLED),
  },
  /** Added: revoke (is_active = false), final and idempotent. */
  revoke: {
    method: 'DELETE',
    path: '/shares/:id',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  stats: {
    method: 'GET',
    path: '/shares/:id/stats',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    query: shareStatsQuerySchema,
    response: shareStatsResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
} as const satisfies Record<string, RouteContract>;

/** Unknown or malformed token, and a share that serves nothing. */
const SHARE_LOOKUP_ERRORS = [ErrorCode.NOT_FOUND, ErrorCode.SHARE_EXPIRED] as const;
/** ...plus the login and password gates. */
const SHARE_GATE_ERRORS = [
  ...SHARE_LOOKUP_ERRORS,
  ErrorCode.LOGIN_REQUIRED,
  ErrorCode.PASSWORD_REQUIRED,
] as const;
/** The selfie upload of face search and face deletion. */
const SELFIE_UPLOAD: MultipartSpec = {
  fileField: SELFIE_FIELD_NAME,
  mimeTypes: SELFIE_MIME_TYPES,
  maxFilesConfigKey: 'FACE_MAX_SELFIES',
};
/** Errors of a selfie scan, whatever its purpose. */
const SELFIE_SCAN_ERRORS = [
  ErrorCode.CONSENT_REQUIRED,
  ErrorCode.NO_FACE_DETECTED,
  ErrorCode.PAYLOAD_TOO_LARGE,
  ErrorCode.UNSUPPORTED_FILE_TYPE,
] as const;

/** Public share-page routes (Phase 3); see api/share-page for the rules. */
export const PUBLIC_SHARE_ROUTES = {
  /** Meta for SSR and OG tags; reports the login and password gates as flags. */
  meta: {
    method: 'GET',
    path: '/s/:token',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    response: shareMetaResponseSchema,
    errors: errors(...SHARE_LOOKUP_ERRORS),
  },
  items: {
    method: 'GET',
    path: '/s/:token/items',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    query: shareItemsQuerySchema,
    response: shareItemsResponseSchema,
    errors: errors(...SHARE_GATE_ERRORS),
  },
  /** Sets the share's unlock cookie. */
  unlock: {
    method: 'POST',
    path: '/s/:token/unlock',
    status: 204,
    auth: 'public',
    params: shareTokenParamsSchema,
    body: unlockShareBodySchema,
    errors: errors(...SHARE_LOOKUP_ERRORS, ErrorCode.LOGIN_REQUIRED, ErrorCode.PASSWORD_INCORRECT),
  },
  /**
   * Give consent. The gates depend on `purpose` (CONSENT_PURPOSE_GATES): `face_search` has every
   * share gate and FEATURE_DISABLED; `face_deletion` checks the token only. The error list is the
   * union.
   */
  giveConsent: {
    method: 'POST',
    path: '/s/:token/consent',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    body: giveConsentBodySchema,
    response: consentResponseSchema,
    errors: errors(
      ...SHARE_GATE_ERRORS,
      ErrorCode.FEATURE_DISABLED,
      ErrorCode.CONSENT_VERSION_MISMATCH,
    ),
  },
  /**
   * Withdraw consent. Only the token lookup applies (NOT_FOUND): withdrawal works on revoked or
   * expired shares and while face search is disabled.
   */
  withdrawConsent: {
    method: 'DELETE',
    path: '/s/:token/consent',
    status: 204,
    auth: 'public',
    params: shareTokenParamsSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  faceSearch: {
    method: 'POST',
    path: '/s/:token/face-search',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    multipart: SELFIE_UPLOAD,
    response: faceSearchResponseSchema,
    errors: errors(
      ...SHARE_GATE_ERRORS,
      ErrorCode.FEATURE_DISABLED,
      ...SELFIE_SCAN_ERRORS,
      ErrorCode.FACE_SEARCH_UNAVAILABLE,
    ),
  },
  /** "ไม่ใช่ฉัน". */
  feedback: {
    method: 'POST',
    path: '/s/:token/feedback',
    status: 204,
    auth: 'public',
    params: shareTokenParamsSchema,
    body: faceFeedbackBodySchema,
    errors: errors(...SHARE_GATE_ERRORS, ErrorCode.FEATURE_DISABLED),
  },
  /**
   * Added (Phase 3 review): what the "ขอลบใบหน้าของฉัน" page needs. Token lookup only, so it works
   * on revoked or expired shares, without unlocking or signing in, and with the flag off.
   */
  faceDeletionInfo: {
    method: 'GET',
    path: '/s/:token/face-deletion',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    response: faceDeletionInfoResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  /**
   * "ขอลบใบหน้าของฉัน". Token lookup plus a current `face_deletion` consent only: never
   * SHARE_EXPIRED, LOGIN_REQUIRED, PASSWORD_REQUIRED or FEATURE_DISABLED (PDPA; ADR 0007).
   */
  faceDeletion: {
    method: 'POST',
    path: '/s/:token/face-deletion',
    status: 202,
    auth: 'public',
    params: shareTokenParamsSchema,
    multipart: SELFIE_UPLOAD,
    response: faceDeletionResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ...SELFIE_SCAN_ERRORS),
  },
  /** One file: a signed URL; several: a zip job (Idempotency-Key required). */
  downloads: {
    method: 'POST',
    path: '/s/:token/downloads',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    headers: downloadsHeadersSchema,
    body: createDownloadBodySchema,
    response: createDownloadResponseSchema,
    errors: errors(
      ...SHARE_GATE_ERRORS,
      ErrorCode.DOWNLOAD_NOT_ALLOWED,
      ErrorCode.ZIP_TOO_LARGE,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
    ),
  },
  /**
   * Poll a zip job. Moved from `/zip-jobs/:id` (Phase 3 review) so the share's unlock cookie
   * (Path `/api/s/{token}`) reaches it and the normal share gates apply.
   */
  zipJob: {
    method: 'GET',
    path: '/s/:token/zip-jobs/:id',
    status: 200,
    auth: 'public',
    params: shareZipJobParamsSchema,
    response: zipJobResponseSchema,
    errors: errors(...SHARE_GATE_ERRORS),
  },
} as const satisfies Record<string, RouteContract>;

/**
 * The activity events each public share route may write (see share/activity). A route not listed
 * with a type never writes it. In particular `meta` (`GET /s/:token`) writes nothing, although it
 * issues the cover URL: it is fetched by SSR and by link unfurlers (LINE, Facebook), not only by
 * people, so counting it would inflate visitors. Views come only from what the browser fetches
 * for the grid (`items` pages) and from face-search results.
 * - `downloads` writes `download` for a single file only; a zip job writes nothing until
 *   `zipJob` first issues the archive's URL (`zip`, once per job).
 * - `faceSearch` writes one `scan` and one `view` (its response issues view URLs).
 * - `faceDeletion` writes nothing (`face_deletions` holds its counts).
 */
export const PUBLIC_SHARE_ROUTE_ACTIVITY = {
  meta: [],
  items: ['view'],
  unlock: [],
  giveConsent: [],
  withdrawConsent: [],
  faceSearch: ['scan', 'view'],
  feedback: [],
  faceDeletionInfo: [],
  faceDeletion: [],
  downloads: ['download'],
  zipJob: ['zip'],
} as const satisfies Record<keyof typeof PUBLIC_SHARE_ROUTES, readonly ActivityType[]>;

/** True when the public share route `route` may write activity events of `type`. */
export function publicShareRouteWritesActivity(
  route: keyof typeof PUBLIC_SHARE_ROUTES,
  type: ActivityType,
): boolean {
  return (PUBLIC_SHARE_ROUTE_ACTIVITY[route] as readonly ActivityType[]).includes(type);
}

/** Billing routes (Phase 4); see api/billing and billing/subscription for the rules. */
export const BILLING_ROUTES = {
  /** Public price list: active plans except the trial. */
  plans: {
    method: 'GET',
    path: '/plans',
    status: 200,
    auth: 'public',
    response: plansResponseSchema,
    errors: errors(),
  },
  /** Start a purchase (Idempotency-Key required). */
  checkout: {
    method: 'POST',
    path: '/billing/checkout',
    status: 201,
    auth: 'photographer',
    headers: checkoutHeadersSchema,
    body: createCheckoutBodySchema,
    response: checkoutResponseSchema,
    errors: errors(
      ErrorCode.PLAN_NOT_FOUND,
      ErrorCode.PLAN_CHANGE_INVALID,
      ErrorCode.CHECKOUT_PENDING,
      ErrorCode.CHECKOUT_EXPIRED,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      ErrorCode.PAYMENT_GATEWAY_ERROR,
    ),
  },
  /** Poll a payment until it is final. */
  payment: {
    method: 'GET',
    path: '/billing/payments/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: paymentViewSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  subscription: {
    method: 'GET',
    path: '/billing/subscription',
    status: 200,
    auth: 'photographer',
    response: subscriptionResponseSchema,
    errors: errors(),
  },
  /** Auto-renew off at period end (idempotent; a prepaid subscription is returned unchanged). */
  cancelSubscription: {
    method: 'POST',
    path: '/billing/subscription/cancel',
    status: 200,
    auth: 'photographer',
    response: subscriptionResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.PAYMENT_GATEWAY_ERROR),
  },
  /** Gateway webhooks: verify, store, apply in one transaction, answer 2xx. */
  webhook: {
    method: 'POST',
    path: '/billing/webhooks/:gateway',
    status: 200,
    auth: 'webhook',
    params: webhookParamsSchema,
    rawBody: true,
    response: webhookResponseSchema,
    errors: [
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.NOT_FOUND,
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      ErrorCode.PAYLOAD_TOO_LARGE,
      ErrorCode.INTERNAL_ERROR,
    ],
  },
} as const satisfies Record<string, RouteContract>;

/**
 * Sign-in routes of the API's own issuer (ADR 0008 section 4); see api/auth. All `bff`. With
 * AUTH_PROVIDER=cognito they answer NOT_FOUND. Every sign-in writes nothing to activity_events;
 * admin sign-ins (successful and failed) are written to audit_log (AUTH_AUDIT_ACTIONS).
 */
export const AUTH_ROUTES = {
  /** What the sign-in pages may offer. */
  providers: {
    method: 'GET',
    path: '/auth/providers',
    status: 200,
    auth: 'bff',
    response: authProvidersResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  oidcStart: {
    method: 'POST',
    path: '/auth/oidc/:provider/start',
    status: 200,
    auth: 'bff',
    params: oidcProviderParamsSchema,
    body: oidcStartBodySchema,
    response: oidcStartResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.AUTH_PROVIDER_UNAVAILABLE),
  },
  oidcCallback: {
    method: 'POST',
    path: '/auth/oidc/callback',
    status: 200,
    auth: 'bff',
    body: oidcCallbackBodySchema,
    response: authTokenResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.LOGIN_STATE_INVALID,
      ErrorCode.IDENTITY_PROVIDER_ERROR,
    ),
  },
  /** AUTH_PROVIDER=local only (NOT_FOUND otherwise); users pool only. */
  devLogin: {
    method: 'POST',
    path: '/auth/dev/login',
    status: 200,
    auth: 'bff',
    body: devLoginBodySchema,
    response: authTokenResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  refresh: {
    method: 'POST',
    path: '/auth/refresh',
    status: 200,
    auth: 'bff',
    body: refreshBodySchema,
    response: authTokenResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.REFRESH_TOKEN_INVALID,
      ErrorCode.REFRESH_TOKEN_REUSED,
    ),
  },
  logout: {
    method: 'POST',
    path: '/auth/logout',
    status: 204,
    auth: 'bff',
    body: logoutBodySchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  adminLogin: {
    method: 'POST',
    path: '/auth/admin/login',
    status: 200,
    auth: 'bff',
    body: adminLoginBodySchema,
    response: adminLoginResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.INVALID_CREDENTIALS),
  },
  /** Answers admins-pool tokens with `amr` ["pwd", "otp", "mfa"]. */
  adminMfa: {
    method: 'POST',
    path: '/auth/admin/mfa',
    status: 200,
    auth: 'bff',
    body: adminMfaBodySchema,
    response: authTokenResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.LOGIN_STATE_INVALID, ErrorCode.MFA_INVALID),
  },
} as const satisfies Record<string, RouteContract>;

/** Every route with a contract, by module. */
export const API_ROUTES = {
  drive: DRIVE_ROUTES,
  uploads: UPLOAD_ROUTES,
  me: ME_ROUTES,
  shares: SHARE_ROUTES,
  publicShare: PUBLIC_SHARE_ROUTES,
  billing: BILLING_ROUTES,
  auth: AUTH_ROUTES,
} as const;

/** Every route as a flat list, e.g. for OpenAPI generation. */
export const ALL_ROUTES: readonly RouteContract[] = Object.values(API_ROUTES).flatMap(
  (group) => Object.values(group) as RouteContract[],
);

/** Names of the `:param` segments of a route path. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

export type PathParams<P extends string> = { [K in PathParamNames<P>]: string };

export interface ApiPathOptions {
  /** Prepend {@link API_PREFIX} (default true). NestJS controllers use the bare path. */
  prefix?: boolean;
}

/**
 * The URL path of a route with its params filled in and URL-encoded, e.g.
 * `apiPath(DRIVE_ROUTES.listChildren, { id: 'root' })` is `/api/drive/folders/root/children`.
 * Throws when a param is missing or empty.
 */
export function apiPath<P extends string>(
  route: { path: P },
  ...[params, options]: PathParamNames<P> extends never
    ? [params?: Record<string, never>, options?: ApiPathOptions]
    : [params: PathParams<P>, options?: ApiPathOptions]
): string {
  const values = (params ?? {}) as Record<string, string | undefined>;
  const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      throw new RangeError(`Missing path param ${name} for ${route.path}`);
    }
    return encodeURIComponent(value);
  });
  return options?.prefix === false ? path : `${API_PREFIX}${path}`;
}
