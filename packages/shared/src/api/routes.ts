import type { z } from 'zod';
import type { ActivityType } from '../domain';
import { ErrorCode } from '../errors';
import {
  adminSystemResponseSchema,
  actAsResponseSchema,
  adminUserSchema,
  cashPaymentSchema,
  createAdminUserBodySchema,
  createCashPaymentBodySchema,
  createCashPaymentHeadersSchema,
  listAdminUsersQuerySchema,
  listAdminUsersResponseSchema,
  listCashPaymentsQuerySchema,
  listCashPaymentsResponseSchema,
  resetAdminUserPasswordBodySchema,
  updateAdminUserBodySchema,
} from './admin';
import {
  adminChangePasswordBodySchema,
  adminChangePasswordResponseSchema,
  adminLoginBodySchema,
  adminLoginResponseSchema,
  adminMfaBodySchema,
  authProvidersResponseSchema,
  authTokenResponseSchema,
  actAsBodySchema,
  devLoginBodySchema,
  logoutBodySchema,
  oidcCallbackBodySchema,
  oidcProviderParamsSchema,
  oidcStartBodySchema,
  oidcStartResponseSchema,
  photographerChangePasswordBodySchema,
  photographerChangePasswordResponseSchema,
  photographerPasswordResetConfirmBodySchema,
  photographerPasswordResetRequestBodySchema,
  photographerSignInBodySchema,
  photographerSignInResponseSchema,
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
  adminUserFinanceResponseSchema,
  createExpenseBodySchema,
  expenseSchema,
  financeQuerySchema,
  financeResponseSchema,
  listAuditLogQuerySchema,
  listAuditLogResponseSchema,
  listExpensesQuerySchema,
  listExpensesResponseSchema,
} from './finance';
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
import {
  createDesignAssetBodySchema,
  createDesignAssetResponseSchema,
  createDesignBodySchema,
  designAssetViewSchema,
  designSchema,
  listDesignAssetsQuerySchema,
  listDesignAssetsResponseSchema,
  listDesignsResponseSchema,
  updateDesignBodySchema,
} from './designs';
import { meResponseSchema } from './me';
import {
  createPackageOrderBodySchema,
  createPackageOrderHeadersSchema,
  createPackageOrderResponseSchema,
  myPackageResponseSchema,
  packageOrderFakeResultBodySchema,
  packageOrderTokenHeadersSchema,
  packageOrderViewSchema,
  packagesResponseSchema,
  packageWebhookParamsSchema,
  signupFreeBodySchema,
  signupFreeConfirmBodySchema,
} from './packages';
import {
  copyFileBodySchema,
  copyFileResponseSchema,
  downloadFolderBodySchema,
  downloadFolderResponseSchema,
  folderSummaryResponseSchema,
  getFileResponseSchema,
  driveStatsQuerySchema,
  driveStatsResponseSchema,
  listRecentQuerySchema,
  listRecentResponseSchema,
  ownerZipJobResponseSchema,
  searchDriveQuerySchema,
  searchDriveResponseSchema,
} from './studio';
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
  captchaHeadersSchema,
  SELFIE_FIELD_NAME,
  SELFIE_MIME_TYPES,
  shareItemsQuerySchema,
  shareChangesResponseSchema,
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

/** `PUT` since ADR 0013 (`PUT /designs/:id`): web's BFF proxy must forward it too. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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
 *   server-side by the web and admin BFFs only, with the key in BFF_KEY_HEADER that the route's
 *   `bffKey` accepts (missing, wrong or the other app's key: UNAUTHENTICATED). Never proxied from the browser (the web's generic `/bff`
 *   proxy must refuse them like `public` and `webhook`), no cookies, no Origin check.
 * Every server-side call from web or admin (any RouteAuth) sends BFF_KEY_HEADER and the end
 * user's IP in BFF_CLIENT_IP_HEADER; the API trusts that IP only with a valid key.
 * - `admin` (ADR 0010): an admins-pool token (role `admin`) whose `amr` has the methods
 *   ADMIN_MFA_MODE requires (adminRequiredAmr: `pwd` with `off`, the default since ADR 0011
 *   decision 4; `pwd` and `otp` with `totp`), sent by the admin app's BFF with AUTH_ADMIN_BFF_KEY
 *   (`bffKey: 'admins'`; any other key or none: UNAUTHENTICATED). Without the methods:
 *   MFA_REQUIRED. Every `/admin/*` route. The guard reads the mode from the api's config
 *   (hasRequiredAmr(pool, amr, config.admin.mfaMode)), never from the token.
 * Admins (admins-pool tokens) use only `/admin/*` routes; anywhere else they are UNAUTHENTICATED.
 * Every `photographer`, `user` and `admin` route answers ACCOUNT_DISABLED for a disabled account,
 * and every `photographer` and `user` route except PASSWORD_CHANGE_ALLOWED_ROUTES answers
 * PASSWORD_CHANGE_REQUIRED for a restricted session (PASSWORD_CHANGE_CLAIM).
 */
export type RouteAuth = 'photographer' | 'user' | 'public' | 'webhook' | 'bff' | 'admin';

/**
 * Which BFF key (BFF_KEY_HEADER) a route accepts (ADR 0010 round 2). web holds AUTH_BFF_KEY (the
 * users pool's key), the admin app AUTH_ADMIN_BFF_KEY (the admins pool's); the API knows the
 * calling app by the key. A missing key, an unknown one or the other app's key is
 * UNAUTHENTICATED, so a compromised web server can't use a stolen admin token or drive admin
 * sign-in.
 * - `users`: web's key only (LINE/Google, dev login, photographer sign-in);
 * - `admins`: the admin app's key only (every `admin` route; admin login, password and MFA steps);
 * - `request`: the key of the pool the request concerns: POST /auth/refresh, the body's `pool`
 *   (a mismatch is UNAUTHENTICATED); POST /auth/logout, the pool of the token's session (a token of
 *   the other pool is treated like an unknown one: 204, nothing revoked, so the answer reveals
 *   nothing);
 * - `either`: either key (GET /auth/providers: nothing secret).
 * Routes without `bffKey` need no key; there either valid key only lets the API trust
 * BFF_CLIENT_IP_HEADER.
 */
export const BFF_KEY_SCOPES = ['users', 'admins', 'request', 'either'] as const;
export type BffKeyScope = (typeof BFF_KEY_SCOPES)[number];

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
  /**
   * Which BFF key the route accepts (BffKeyScope). Set on every `bff` and `admin` route; absent
   * elsewhere (no key needed).
   */
  bffKey?: BffKeyScope;
  /**
   * The response carries tokens (a refresh token), so web and admin call the route from server
   * code only and store the tokens in their session cookie; the generic browser proxy (`/bff/*`)
   * must refuse it like `bff` routes.
   */
  serverOnly?: true;
  /**
   * Added (ADR 0026): on a `bff` route, the user token the route accepts but doesn't require. When
   * the BFF forwards a bearer token it must be a valid token of this role (else UNAUTHENTICATED),
   * and the account checks of that role apply (ACCOUNT_DISABLED, PASSWORD_CHANGE_REQUIRED);
   * without one the request is anonymous. Today only POST /package-orders (`photographer`).
   */
  optionalAuth?: 'photographer';
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

/**
 * Errors of every `photographer` and `user` route (ADR 0010): a disabled account, and a session
 * that must change its temporary password first.
 */
export const SIGNED_IN_ROUTE_ERRORS = [
  ErrorCode.ACCOUNT_DISABLED,
  ErrorCode.PASSWORD_CHANGE_REQUIRED,
] as const;

const signedIn = (...specific: ErrorCode[]): readonly ErrorCode[] =>
  errors(...SIGNED_IN_ROUTE_ERRORS, ...specific);

/** Errors of every `admin` route. */
export const ADMIN_ROUTE_ERRORS = [ErrorCode.MFA_REQUIRED, ErrorCode.ACCOUNT_DISABLED] as const;

const adminErrors = (...specific: ErrorCode[]): readonly ErrorCode[] =>
  errors(...ADMIN_ROUTE_ERRORS, ...specific);

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
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  createFolder: {
    method: 'POST',
    path: '/drive/folders',
    status: 201,
    auth: 'photographer',
    body: createFolderBodySchema,
    response: driveFolderSchema,
    errors: signedIn(ErrorCode.NOT_FOUND, ErrorCode.NAME_TAKEN, ErrorCode.FOLDER_DEPTH_EXCEEDED),
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
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.NAME_TAKEN,
      ErrorCode.INVALID_MOVE,
      ErrorCode.FOLDER_DEPTH_EXCEEDED,
      ErrorCode.COVER_FILE_INVALID,
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
    errors: signedIn(ErrorCode.NOT_FOUND, ErrorCode.NAME_TAKEN, ErrorCode.UNSUPPORTED_FILE_TYPE),
  },
  trashItems: {
    method: 'POST',
    path: '/drive/items/trash',
    status: 200,
    auth: 'photographer',
    body: driveItemsBodySchema,
    response: trashItemsResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  restoreItems: {
    method: 'POST',
    path: '/drive/items/restore',
    status: 200,
    auth: 'photographer',
    body: driveItemsBodySchema,
    response: restoreItemsResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Added (not in the spec's route list): the trash view needs a listing. */
  listTrash: {
    method: 'GET',
    path: '/drive/trash',
    status: 200,
    auth: 'photographer',
    query: listTrashQuerySchema,
    response: listTrashResponseSchema,
    errors: signedIn(),
  },
  emptyTrash: {
    method: 'DELETE',
    path: '/drive/trash',
    status: 202,
    auth: 'photographer',
    response: emptyTrashResponseSchema,
    errors: signedIn(),
  },
  /**
   * Added (Phase 3): extend face indexing of a folder subtree (on by default since ADR 0011, no
   * confirmation), or turn it off. See updateFaceIndexBodySchema.
   */
  updateFaceIndex: {
    method: 'PATCH',
    path: '/drive/folders/:id/face-index',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateFaceIndexBodySchema,
    response: driveFolderSchema,
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.FEATURE_DISABLED,
      ErrorCode.SUBSCRIPTION_INACTIVE,
      // ADR 0026: turning indexing on with an expired package (turning it off always works).
      ErrorCode.PLAN_EXPIRED,
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
    errors: signedIn(ErrorCode.NOT_FOUND, ErrorCode.CONFLICT),
  },
  /**
   * Added (not in the spec's route list): the studio's storage meter ("ใช้ไป X จาก Y": used +
   * reserved of quota; the aside's "เพิ่มพื้นที่เก็บข้อมูล" goes to billing).
   */
  usage: {
    method: 'GET',
    path: '/drive/usage',
    status: 200,
    auth: 'photographer',
    response: driveUsageResponseSchema,
    errors: signedIn(),
  },

  // Wave 7: Drive-style studio (api/studio for the rules).
  /** "ทำสำเนา" of one file (copyFileBodySchema). */
  copyFile: {
    method: 'POST',
    path: '/drive/files/:id/copy',
    status: 201,
    auth: 'photographer',
    params: idParamsSchema,
    body: copyFileBodySchema,
    response: copyFileResponseSchema,
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.CONFLICT,
      ErrorCode.NAME_TAKEN,
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
    ),
  },
  /** The owner's folder as a ZIP (downloadFolderBodySchema); poll ownerZipJob. */
  downloadFolder: {
    method: 'POST',
    path: '/drive/folders/:id/download',
    status: 202,
    auth: 'photographer',
    params: idParamsSchema,
    headers: downloadsHeadersSchema,
    body: downloadFolderBodySchema,
    response: downloadFolderResponseSchema,
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.CONFLICT,
      ErrorCode.ZIP_TOO_LARGE,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
    ),
  },
  ownerZipJob: {
    method: 'GET',
    path: '/drive/zip-jobs/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: ownerZipJobResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** "ล่าสุด". */
  recent: {
    method: 'GET',
    path: '/drive/recent',
    status: 200,
    auth: 'photographer',
    query: listRecentQuerySchema,
    response: listRecentResponseSchema,
    errors: signedIn(),
  },
  /** ADR 0023: photos uploaded and downloaded, for the Events page chart. */
  stats: {
    method: 'GET',
    path: '/drive/stats',
    status: 200,
    auth: 'photographer',
    query: driveStatsQuerySchema,
    response: driveStatsResponseSchema,
    errors: signedIn(),
  },
  search: {
    method: 'GET',
    path: '/drive/search',
    status: 200,
    auth: 'photographer',
    query: searchDriveQuerySchema,
    response: searchDriveResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** "ข้อมูลไฟล์" of a file. */
  getFile: {
    method: 'GET',
    path: '/drive/files/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: getFileResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** "ข้อมูลไฟล์" of a folder. */
  folderSummary: {
    method: 'GET',
    path: '/drive/folders/:id/summary',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: folderSummaryResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
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
    errors: signedIn(
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      ErrorCode.FILE_TOO_LARGE,
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.NOT_FOUND,
      ErrorCode.NAME_TAKEN,
      ErrorCode.FOLDER_DEPTH_EXCEEDED,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      ErrorCode.CONFLICT,
      // ADR 0026: package expired, or one more photo would pass the package's photo limit.
      ErrorCode.PLAN_EXPIRED,
      ErrorCode.PHOTO_LIMIT_REACHED,
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
    errors: signedIn(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  /** Added: parts already uploaded, for resuming (Uppy `listParts`). */
  listParts: {
    method: 'GET',
    path: '/uploads/:id/parts',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: listPartsResponseSchema,
    errors: signedIn(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  complete: {
    method: 'POST',
    path: '/uploads/:id/complete',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: completeUploadBodySchema,
    response: completeUploadResponseSchema,
    errors: signedIn(
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
    errors: signedIn(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.CONFLICT),
  },
} as const satisfies Record<string, RouteContract>;

/** The signed-in user (Phase 3). */
export const ME_ROUTES = {
  /**
   * Provisions the `users` row on first use (LINE/Google viewers only; password accounts exist
   * already). Allowed for a restricted session (`passwordChangeRequired`).
   */
  get: {
    method: 'GET',
    path: '/me',
    status: 200,
    auth: 'user',
    response: meResponseSchema,
    errors: errors(ErrorCode.ACCOUNT_DISABLED),
  },
  /**
   * @deprecated ADR 0010: always FORBIDDEN (accounts come from admins only, POST /admin/users).
   * It never succeeds, so it advertises no body and no response (the 204 is nominal). Kept only
   * until the api controller and the api/web tests that still reference it drop it; then removed.
   */
  becomePhotographer: {
    method: 'POST',
    path: '/me/photographer',
    status: 204,
    auth: 'user',
    errors: signedIn(),
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
    errors: signedIn(),
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
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.FEATURE_DISABLED,
      ErrorCode.LOGIN_PROVIDER_UNAVAILABLE,
      ErrorCode.DESIGN_NOT_FOUND,
      ErrorCode.PLAN_EXPIRED,
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
    errors: signedIn(),
  },
  /** Added: one share, for its settings page. */
  get: {
    method: 'GET',
    path: '/shares/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: ownerShareSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
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
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.CONFLICT,
      ErrorCode.FEATURE_DISABLED,
      ErrorCode.LOGIN_PROVIDER_UNAVAILABLE,
      ErrorCode.DESIGN_NOT_FOUND,
      // ADR 0026: re-activating or un-pausing with an expired package (other edits still work).
      ErrorCode.PLAN_EXPIRED,
    ),
  },
  /** Added: revoke (is_active = false), final and idempotent. */
  revoke: {
    method: 'DELETE',
    path: '/shares/:id',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  stats: {
    method: 'GET',
    path: '/shares/:id/stats',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    query: shareStatsQuerySchema,
    response: shareStatsResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
} as const satisfies Record<string, RouteContract>;

/**
 * Share page designs and their images (ADR 0013); see api/designs for the rules. Photographer
 * only and owner-scoped; another owner's design or image is NOT_FOUND. The image routes come
 * before `get` so first-match routers see `GET /designs/assets` before `GET /designs/:id`;
 * NestJS controllers must declare them in that order too.
 */
export const DESIGN_ROUTES = {
  list: {
    method: 'GET',
    path: '/designs',
    status: 200,
    auth: 'photographer',
    response: listDesignsResponseSchema,
    errors: signedIn(),
  },
  /** From a template, a document or blank. Body up to DESIGN_BODY_MAX_BYTES. */
  create: {
    method: 'POST',
    path: '/designs',
    status: 201,
    auth: 'photographer',
    body: createDesignBodySchema,
    response: designSchema,
    errors: signedIn(
      ErrorCode.DESIGN_LIMIT_REACHED,
      ErrorCode.DESIGN_DOC_TOO_LARGE,
      ErrorCode.DESIGN_ASSET_NOT_FOUND,
      ErrorCode.PAYLOAD_TOO_LARGE,
    ),
  },
  listAssets: {
    method: 'GET',
    path: '/designs/assets',
    status: 200,
    auth: 'photographer',
    query: listDesignAssetsQuerySchema,
    response: listDesignAssetsResponseSchema,
    errors: signedIn(),
  },
  createAsset: {
    method: 'POST',
    path: '/designs/assets',
    status: 201,
    auth: 'photographer',
    body: createDesignAssetBodySchema,
    response: createDesignAssetResponseSchema,
    errors: signedIn(
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      ErrorCode.FILE_TOO_LARGE,
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.SUBSCRIPTION_INACTIVE,
    ),
  },
  /** After the PUT: `processing` and the design.asset job. Idempotent. */
  completeAsset: {
    method: 'POST',
    path: '/designs/assets/:id/complete',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: designAssetViewSchema,
    errors: signedIn(ErrorCode.NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  getAsset: {
    method: 'GET',
    path: '/designs/assets/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: designAssetViewSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Added: the editor's Uploads panel. */
  get: {
    method: 'GET',
    path: '/designs/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: designSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Save with the revision the editor started from. Body up to DESIGN_BODY_MAX_BYTES. */
  update: {
    method: 'PUT',
    path: '/designs/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateDesignBodySchema,
    response: designSchema,
    errors: signedIn(
      ErrorCode.NOT_FOUND,
      ErrorCode.DESIGN_REVISION_CONFLICT,
      ErrorCode.DESIGN_DOC_TOO_LARGE,
      ErrorCode.DESIGN_ASSET_NOT_FOUND,
      ErrorCode.PAYLOAD_TOO_LARGE,
    ),
  },
  /** Hard delete; its shares' design_id becomes null. */
  delete: {
    method: 'DELETE',
    path: '/designs/:id',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Make it the default (clears the previous one in the same transaction). Idempotent. */
  setDefault: {
    method: 'POST',
    path: '/designs/:id/default',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Added: stop it being the default (a no-op when it isn't). */
  clearDefault: {
    method: 'DELETE',
    path: '/designs/:id/default',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Reserve, insert the asset row, presign one PUT. */
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
  changes: {
    method: 'GET',
    path: '/s/:token/changes',
    status: 200,
    auth: 'public',
    params: shareTokenParamsSchema,
    response: shareChangesResponseSchema,
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
    /** The optional Turnstile token, read only over a rate limit (config/captcha.ts). */
    headers: captchaHeadersSchema,
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
    /** The optional Turnstile token, read only over a rate limit (config/captcha.ts). */
    headers: captchaHeadersSchema,
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
  changes: [],
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

/**
 * Billing routes (Phase 4); see api/billing and billing/subscription for the rules. With
 * BILLING_MODE=offline (ADR 0010, the default) every one of them answers NOT_FOUND.
 */
export const BILLING_ROUTES = {
  /** Public price list: active plans except the trial. */
  plans: {
    method: 'GET',
    path: '/plans',
    status: 200,
    auth: 'public',
    response: plansResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
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
    errors: signedIn(
      ErrorCode.NOT_FOUND,
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
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  subscription: {
    method: 'GET',
    path: '/billing/subscription',
    status: 200,
    auth: 'photographer',
    response: subscriptionResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND),
  },
  /** Auto-renew off at period end (idempotent; a prepaid subscription is returned unchanged). */
  cancelSubscription: {
    method: 'POST',
    path: '/billing/subscription/cancel',
    status: 200,
    auth: 'photographer',
    response: subscriptionResponseSchema,
    errors: signedIn(ErrorCode.NOT_FOUND, ErrorCode.PAYMENT_GATEWAY_ERROR),
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
 * Sign-in routes of the API's own issuer (ADR 0008 section 4, ADR 0010); see api/auth. All `bff`.
 * With AUTH_PROVIDER=cognito they answer NOT_FOUND. Every sign-in writes nothing to
 * activity_events; admin and photographer sign-ins (successful and failed) are written to
 * audit_log (AUTH_AUDIT_ACTIONS).
 */
export const AUTH_ROUTES = {
  /** What the sign-in pages may offer (`oidc` may be empty: authProvidersOf). */
  providers: {
    method: 'GET',
    path: '/auth/providers',
    status: 200,
    auth: 'bff',
    bffKey: 'either',
    response: authProvidersResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  oidcStart: {
    method: 'POST',
    path: '/auth/oidc/:provider/start',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
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
    bffKey: 'users',
    body: oidcCallbackBodySchema,
    response: authTokenResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.LOGIN_STATE_INVALID,
      ErrorCode.IDENTITY_PROVIDER_ERROR,
      ErrorCode.ACCOUNT_DISABLED,
    ),
  },
  /** AUTH_PROVIDER=local only (NOT_FOUND otherwise); users pool only. */
  devLogin: {
    method: 'POST',
    path: '/auth/dev/login',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    body: devLoginBodySchema,
    response: authTokenResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.ACCOUNT_DISABLED),
  },
  refresh: {
    method: 'POST',
    path: '/auth/refresh',
    status: 200,
    auth: 'bff',
    bffKey: 'request',
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
    bffKey: 'request',
    body: logoutBodySchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  /**
   * Answers the first step (ADMIN_SIGN_IN_STEPS). ADMIN_MFA_MODE=totp: tokens come only from
   * adminMfa. ADMIN_MFA_MODE=off (ADR 0011): `signed_in` with tokens, or `change_password`.
   */
  adminLogin: {
    method: 'POST',
    path: '/auth/admin/login',
    status: 200,
    auth: 'bff',
    bffKey: 'admins',
    body: adminLoginBodySchema,
    response: adminLoginResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.INVALID_CREDENTIALS, ErrorCode.ACCOUNT_DISABLED),
  },
  /**
   * Added (ADR 0010): the `change_password` step of a temporary admin password. With
   * ADMIN_MFA_MODE=off it answers `signed_in` (ADR 0011).
   */
  adminChangePassword: {
    method: 'POST',
    path: '/auth/admin/password',
    status: 200,
    auth: 'bff',
    bffKey: 'admins',
    body: adminChangePasswordBodySchema,
    response: adminChangePasswordResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.LOGIN_STATE_INVALID,
      ErrorCode.PASSWORD_TOO_WEAK,
      ErrorCode.ACCOUNT_DISABLED,
    ),
  },
  /**
   * The `totp` or `enrol_totp` step. Answers admins-pool tokens with `amr` ["pwd", "otp", "mfa"],
   * after storing what earlier steps changed (ADMIN_SIGN_IN_STEPS). Unused with
   * ADMIN_MFA_MODE=off: no challenge is ever for it, so it answers LOGIN_STATE_INVALID.
   */
  adminMfa: {
    method: 'POST',
    path: '/auth/admin/mfa',
    status: 200,
    auth: 'bff',
    bffKey: 'admins',
    body: adminMfaBodySchema,
    response: authTokenResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.LOGIN_STATE_INVALID,
      ErrorCode.MFA_INVALID,
      ErrorCode.ACCOUNT_DISABLED,
    ),
  },
  /**
   * Added (ADR 0010): photographer email + password. A normal or a restricted session
   * (photographerSignInResponseSchema); writes AUTH_AUDIT_ACTIONS `auth.photographer.*`.
   */
  /**
   * ADR 0018: exchanges an admin's one-time act-as code for a session of the photographer (users
   * pool, ADMIN_ACT_AS_SESSION_SECONDS, marked with the acting admin). Web's /auth/act-as calls it.
   * An unknown, used or expired code, or an admin or photographer no longer active:
   * UNAUTHENTICATED.
   */
  actAs: {
    method: 'POST',
    path: '/auth/act-as',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    body: actAsBodySchema,
    response: authTokenResponseSchema,
    // UNAUTHENTICATED is common to every route.
    errors: errors(),
  },
  photographerSignIn: {
    method: 'POST',
    path: '/auth/photographer/sign-in',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    body: photographerSignInBodySchema,
    response: photographerSignInResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.INVALID_CREDENTIALS, ErrorCode.ACCOUNT_DISABLED),
  },
  /**
   * ADR 0025, "ลืมรหัสผ่าน": emails a one-time reset link when the email belongs to an active
   * photographer password account. Always 204 otherwise too (never reveals whether an account
   * exists). FEATURE_DISABLED without an account email provider.
   */
  photographerPasswordResetRequest: {
    method: 'POST',
    path: '/auth/photographer/password-reset/request',
    status: 204,
    auth: 'bff',
    bffKey: 'users',
    body: photographerPasswordResetRequestBodySchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.FEATURE_DISABLED),
  },
  /**
   * ADR 0025: sets a new password with the emailed token and answers a new normal session (every
   * other session of the account is revoked); web stores it in the session cookie.
   */
  photographerPasswordResetConfirm: {
    method: 'POST',
    path: '/auth/photographer/password-reset/confirm',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    body: photographerPasswordResetConfirmBodySchema,
    response: authTokenResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.FEATURE_DISABLED,
      ErrorCode.PASSWORD_RESET_INVALID,
      ErrorCode.PASSWORD_TOO_WEAK,
    ),
  },
} as const satisfies Record<string, RouteContract>;

/**
 * The signed-in photographer's own account (ADR 0010). Not `bff`: it needs the photographer's
 * token. `serverOnly`: the web BFF calls it from its own route handler and swaps its session
 * cookie for the new tokens; the browser proxy refuses it.
 */
export const PHOTOGRAPHER_ACCOUNT_ROUTES = {
  /** Forced first change (restricted session) and any later change; answers a new session. */
  changePassword: {
    method: 'POST',
    path: '/auth/photographer/password',
    status: 200,
    auth: 'photographer',
    body: photographerChangePasswordBodySchema,
    response: photographerChangePasswordResponseSchema,
    serverOnly: true,
    errors: errors(
      ErrorCode.ACCOUNT_DISABLED,
      ErrorCode.PASSWORD_INCORRECT,
      ErrorCode.PASSWORD_TOO_WEAK,
    ),
  },
} as const satisfies Record<string, RouteContract>;

/**
 * Admin app routes (ADR 0010; api/admin for the rules). All RouteAuth `admin`; every mutation
 * writes audit_log (ADMIN_AUDIT_ACTIONS) in its transaction.
 */
export const ADMIN_ROUTES = {
  listUsers: {
    method: 'GET',
    path: '/admin/users',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    query: listAdminUsersQuerySchema,
    response: listAdminUsersResponseSchema,
    errors: adminErrors(),
  },
  createUser: {
    method: 'POST',
    path: '/admin/users',
    status: 201,
    auth: 'admin',
    bffKey: 'admins',
    body: createAdminUserBodySchema,
    response: adminUserSchema,
    errors: adminErrors(ErrorCode.EMAIL_TAKEN, ErrorCode.PASSWORD_TOO_WEAK),
  },
  /** Added: one account, for its detail page and after a mutation. */
  getUser: {
    method: 'GET',
    path: '/admin/users/:id',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    params: idParamsSchema,
    response: adminUserSchema,
    errors: adminErrors(ErrorCode.NOT_FOUND),
  },
  /** Rename, disable or enable. */
  updateUser: {
    method: 'PATCH',
    path: '/admin/users/:id',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    params: idParamsSchema,
    body: updateAdminUserBodySchema,
    response: adminUserSchema,
    errors: adminErrors(ErrorCode.NOT_FOUND, ErrorCode.CANNOT_MODIFY_SELF, ErrorCode.LAST_ADMIN),
  },
  resetPassword: {
    method: 'POST',
    path: '/admin/users/:id/reset-password',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    params: idParamsSchema,
    body: resetAdminUserPasswordBodySchema,
    response: adminUserSchema,
    errors: adminErrors(
      ErrorCode.NOT_FOUND,
      ErrorCode.CANNOT_MODIFY_SELF,
      ErrorCode.CONFLICT,
      ErrorCode.PASSWORD_TOO_WEAK,
    ),
  },
  /** ADR 0018: a one-time link that opens a photographer's studio as them. Audited. */
  actAs: {
    method: 'POST',
    path: '/admin/users/:id/act-as',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    params: idParamsSchema,
    response: actAsResponseSchema,
    errors: adminErrors(ErrorCode.NOT_FOUND, ErrorCode.CONFLICT),
  },
  /** ADR 0016: the overview tab (storage, the R2 bucket, the server). Read-only, not audited. */
  system: {
    method: 'GET',
    path: '/admin/system',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    response: adminSystemResponseSchema,
    errors: adminErrors(),
  },
  listCashPayments: {
    method: 'GET',
    path: '/admin/cash-payments',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    query: listCashPaymentsQuerySchema,
    response: listCashPaymentsResponseSchema,
    errors: adminErrors(),
  },
  /** Idempotency-Key required. */
  createCashPayment: {
    method: 'POST',
    path: '/admin/cash-payments',
    status: 201,
    auth: 'admin',
    bffKey: 'admins',
    headers: createCashPaymentHeadersSchema,
    body: createCashPaymentBodySchema,
    response: cashPaymentSchema,
    errors: adminErrors(ErrorCode.NOT_FOUND, ErrorCode.IDEMPOTENCY_KEY_REUSED),
  },
  /** ADR 0027 §1: the audit log, newest first, with filters. Read-only, not audited. */
  auditLog: {
    method: 'GET',
    path: '/admin/audit-log',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    query: listAuditLogQuerySchema,
    response: listAuditLogResponseSchema,
    errors: adminErrors(),
  },
  /** ADR 0027 §2: the expenses ledger (live rows), newest `spent_on` first. */
  listExpenses: {
    method: 'GET',
    path: '/admin/expenses',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    query: listExpensesQuerySchema,
    response: listExpensesResponseSchema,
    errors: adminErrors(),
  },
  /** ADR 0027 §2: record an expense (audited `finance.expense_created`). */
  createExpense: {
    method: 'POST',
    path: '/admin/expenses',
    status: 201,
    auth: 'admin',
    bffKey: 'admins',
    body: createExpenseBodySchema,
    response: expenseSchema,
    errors: adminErrors(),
  },
  /** ADR 0027 §2: soft-delete an expense (audited `finance.expense_deleted`; again: no-op). */
  deleteExpense: {
    method: 'DELETE',
    path: '/admin/expenses/:id',
    status: 204,
    auth: 'admin',
    bffKey: 'admins',
    params: idParamsSchema,
    errors: adminErrors(ErrorCode.NOT_FOUND),
  },
  /** ADR 0027 §3: income, expenses and profit over a range. Read-only, not audited. */
  finance: {
    method: 'GET',
    path: '/admin/finance',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    query: financeQuerySchema,
    response: financeResponseSchema,
    errors: adminErrors(),
  },
  /** ADR 0027 §4: one photographer's orders, payments and estimated cost. Read-only. */
  userFinance: {
    method: 'GET',
    path: '/admin/users/:id/finance',
    status: 200,
    auth: 'admin',
    bffKey: 'admins',
    params: idParamsSchema,
    response: adminUserFinanceResponseSchema,
    errors: adminErrors(ErrorCode.NOT_FOUND),
  },
} as const satisfies Record<string, RouteContract>;

/**
 * Packages, Free sign-up and package orders (ADR 0026; api/packages for the shapes). With
 * PACKAGE_SALES=off, `signupFree`, `signupFreeConfirm` and `createOrder` answer NOT_FOUND; the
 * others keep working (prices on the home page, a buyer's order result, the photographer's
 * package, late gateway callbacks).
 */
export const PACKAGE_ROUTES = {
  /** Public price list for the home page (packagesResponseSchema). */
  list: {
    method: 'GET',
    path: '/packages',
    status: 200,
    auth: 'public',
    response: packagesResponseSchema,
    errors: errors(),
  },
  /**
   * Free sign-up step 1: always 204 for a well-formed body (no account enumeration).
   * FEATURE_DISABLED without an account email provider (ACCOUNT_EMAIL_PROVIDER=off).
   */
  signupFree: {
    method: 'POST',
    path: '/signup/free',
    status: 204,
    auth: 'bff',
    bffKey: 'users',
    body: signupFreeBodySchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.FEATURE_DISABLED),
  },
  /**
   * Free sign-up step 2: creates the account, applies `free` and answers a new normal session
   * (authTokenResponseSchema, as photographer sign-in and password-reset confirm do).
   */
  signupFreeConfirm: {
    method: 'POST',
    path: '/signup/free/confirm',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    body: signupFreeConfirmBodySchema,
    response: authTokenResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.SIGNUP_LINK_INVALID, ErrorCode.PASSWORD_TOO_WEAK),
  },
  /**
   * Start a paid order (Idempotency-Key required). Anonymous, or for the signed-in photographer
   * when the BFF forwards their token (`optionalAuth`). The response carries the order's access
   * token: like every `bff` route it is called from web's server code only, which sets
   * PACKAGE_ORDER_COOKIE.
   */
  createOrder: {
    method: 'POST',
    path: '/package-orders',
    status: 201,
    auth: 'bff',
    bffKey: 'users',
    optionalAuth: 'photographer',
    headers: createPackageOrderHeadersSchema,
    body: createPackageOrderBodySchema,
    response: createPackageOrderResponseSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.PACKAGE_UNAVAILABLE,
      ErrorCode.PAYMENT_UNAVAILABLE,
      ErrorCode.EMAIL_UNAVAILABLE,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      ErrorCode.PAYMENT_GATEWAY_ERROR,
      ...SIGNED_IN_ROUTE_ERRORS,
    ),
  },
  /** Poll one order with its access token (ORDER_TOKEN_HEADER). */
  getOrder: {
    method: 'GET',
    path: '/package-orders/:id',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    params: idParamsSchema,
    headers: packageOrderTokenHeadersSchema,
    response: packageOrderViewSchema,
    errors: errors(ErrorCode.ORDER_NOT_FOUND),
  },
  /** PACKAGE_GATEWAY=fake only (otherwise NOT_FOUND): the fake page's paid / failed buttons. */
  fakeResult: {
    method: 'POST',
    path: '/package-orders/:id/fake-result',
    status: 200,
    auth: 'bff',
    bffKey: 'users',
    params: idParamsSchema,
    headers: packageOrderTokenHeadersSchema,
    body: packageOrderFakeResultBodySchema,
    response: packageOrderViewSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.ORDER_NOT_FOUND),
  },
  /**
   * Gateway callbacks: verify the raw body, then apply in one transaction with the order
   * `FOR UPDATE` (idempotent), answer 2xx.
   */
  webhook: {
    method: 'POST',
    path: '/package-payments/webhooks/:gateway',
    status: 200,
    auth: 'webhook',
    params: packageWebhookParamsSchema,
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
  /** The signed-in photographer's package; JSON `null` when the account is unlimited. */
  myPackage: {
    method: 'GET',
    path: '/me/package',
    status: 200,
    auth: 'photographer',
    response: myPackageResponseSchema,
    errors: signedIn(),
  },
} as const satisfies Record<string, RouteContract>;

/**
 * What a restricted session (PASSWORD_CHANGE_CLAIM) may call; every other `photographer` or
 * `user` route answers PASSWORD_CHANGE_REQUIRED. The `bff` routes (refresh, logout) need no
 * user token and always work.
 */
export const PASSWORD_CHANGE_ALLOWED_ROUTES: readonly RouteContract[] = [
  ME_ROUTES.get,
  PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword,
];

/** True when a restricted session may call `route`. */
export function allowedDuringPasswordChange(
  route: Pick<RouteContract, 'method' | 'path'>,
): boolean {
  return PASSWORD_CHANGE_ALLOWED_ROUTES.some(
    (r) => r.method === route.method && r.path === route.path,
  );
}

/** Every route with a contract, by module. */
export const API_ROUTES = {
  drive: DRIVE_ROUTES,
  uploads: UPLOAD_ROUTES,
  me: ME_ROUTES,
  shares: SHARE_ROUTES,
  designs: DESIGN_ROUTES,
  publicShare: PUBLIC_SHARE_ROUTES,
  billing: BILLING_ROUTES,
  auth: AUTH_ROUTES,
  photographerAccount: PHOTOGRAPHER_ACCOUNT_ROUTES,
  admin: ADMIN_ROUTES,
  packages: PACKAGE_ROUTES,
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
