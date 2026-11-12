import {
  type BillingNotice,
  checkoutPendingDetailsSchema,
  coverFileInvalidDetailsSchema,
  ErrorCode,
  faceSearchUnavailableDetailsSchema,
  planChangeInvalidDetailsSchema,
  fileTooLargeDetailsSchema,
  folderDepthExceededDetailsSchema,
  nameTakenDetailsSchema,
  noFaceDetectedDetailsSchema,
  type PasswordPolicyReason,
  passwordTooWeakDetailsSchema,
  quotaExceededDetailsSchema,
  rateLimitedDetailsSchema,
  shareExpiredDetailsSchema,
  subscriptionInactiveDetailsSchema,
  unsupportedFileTypeDetailsSchema,
  zipTooLargeDetailsSchema,
} from '@shotx/shared';
import { TIME_ZONE } from '../../i18n/config';
import type { Messages } from '../../messages/th';
import { ApiError, ContractError, NetworkError } from '../api/errors';
import { formatBytes } from '../format';

/**
 * The one place that turns errors into Thai copy. Every API ErrorCode has a message in
 * `messages.errors.codes` (an exhaustive Record<ErrorCode, string>); codes with typed `details`
 * get a more specific message when the details parse. Client-side failures (network, bad
 * response, local upload checks) have their own keys under `errors.client`.
 */

type Errors = Messages['errors'];

/** A key under the `errors` namespace. */
export type ErrorMessageKey =
  | `codes.${keyof Errors['codes']}`
  | `hints.${keyof Errors['hints']}`
  | `details.${keyof Errors['details']}`
  | `planChange.${keyof Errors['planChange']}`
  | `passwordPolicy.${keyof Errors['passwordPolicy']}`
  | `coverFile.${keyof Errors['coverFile']}`
  | `notices.${keyof Errors['notices']}`
  | `client.${keyof Errors['client']}`;

export interface ErrorMessage {
  key: ErrorMessageKey;
  values?: Record<string, string | number>;
}

/** Errors raised in the browser before or around an API call (upload pre-checks and S3 PUTs). */
export class ClientError extends Error {
  override readonly name = 'ClientError';

  constructor(
    readonly key: `client.${keyof Errors['client']}`,
    readonly values?: Record<string, string | number>,
  ) {
    super(key);
  }
}

/**
 * Why a new password is refused, from PASSWORD_TOO_WEAK details or the form's own check
 * (passwordPolicyViolation) before sending; `minLength` is the photographer minimum.
 */
export function messageForPasswordPolicy(
  reason: PasswordPolicyReason,
  minLength: number,
): ErrorMessage {
  return { key: `passwordPolicy.${reason}`, values: { minLength } };
}

/** How a message is worded: status labels, and the Intl locale of sizes and times. */
export interface MessageLabels {
  subscriptionStatus: (status: string) => string;
  /** BCP 47 locale (INTL_LOCALE); Thai when absent. */
  locale?: string;
}

/** The message for an error code and its (untrusted) details. */
export function messageForCode(
  code: ErrorCode,
  details: unknown,
  labels: MessageLabels = { subscriptionStatus: (s) => s },
): ErrorMessage {
  const intl = labels.locale ?? 'th-TH';
  const bytes = (n: number) => formatBytes(n, intl);
  switch (code) {
    case ErrorCode.QUOTA_EXCEEDED: {
      const d = quotaExceededDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key: 'details.quotaExceeded',
          values: {
            requested: bytes(d.data.requestedBytes),
            available: bytes(d.data.availableBytes),
          },
        };
      }
      break;
    }
    case ErrorCode.FILE_TOO_LARGE: {
      const d = fileTooLargeDetailsSchema.safeParse(details);
      if (d.success) {
        return { key: 'details.fileTooLarge', values: { max: bytes(d.data.maxBytes) } };
      }
      break;
    }
    case ErrorCode.UNSUPPORTED_FILE_TYPE: {
      const d = unsupportedFileTypeDetailsSchema.safeParse(details);
      if (d.success) {
        if (d.data.hint !== null) return { key: `hints.${d.data.hint}` };
        if (d.data.extension !== null) {
          return { key: 'details.unsupportedExtension', values: { extension: d.data.extension } };
        }
      }
      break;
    }
    case ErrorCode.NAME_TAKEN: {
      const d = nameTakenDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key: d.data.kind === 'folder' ? 'details.folderNameTaken' : 'details.fileNameTaken',
          values: { name: d.data.name },
        };
      }
      break;
    }
    case ErrorCode.FOLDER_DEPTH_EXCEEDED: {
      const d = folderDepthExceededDetailsSchema.safeParse(details);
      if (d.success)
        return { key: 'details.folderDepthExceeded', values: { max: d.data.maxDepth } };
      break;
    }
    case ErrorCode.SUBSCRIPTION_INACTIVE: {
      const d = subscriptionInactiveDetailsSchema.safeParse(details);
      if (d.success) {
        return d.data.status === null
          ? { key: 'details.subscriptionNone' }
          : {
              key: 'details.subscriptionStatus',
              values: { status: labels.subscriptionStatus(d.data.status) },
            };
      }
      break;
    }
    case ErrorCode.SHARE_EXPIRED: {
      // Every reason reads "this link has expired"; the reason adds why.
      const d = shareExpiredDetailsSchema.safeParse(details);
      if (d.success) {
        const keys = {
          revoked: 'details.shareRevoked',
          expired: 'details.shareExpired',
          unavailable: 'details.shareUnavailable',
        } as const;
        return { key: keys[d.data.reason] };
      }
      break;
    }
    case ErrorCode.ZIP_TOO_LARGE: {
      const d = zipTooLargeDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key: 'details.zipTooLarge',
          values: {
            maxFiles: d.data.maxFiles,
            maxBytes: bytes(d.data.maxBytes),
            files: d.data.files,
            bytes: bytes(d.data.bytes),
          },
        };
      }
      break;
    }
    case ErrorCode.NO_FACE_DETECTED: {
      const d = noFaceDetectedDetailsSchema.safeParse(details);
      if (d.success) {
        return { key: 'details.noFaceDetected', values: { count: d.data.selfiesWithoutFace } };
      }
      break;
    }
    case ErrorCode.FACE_SEARCH_UNAVAILABLE: {
      const d = faceSearchUnavailableDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key:
            d.data.reason === 'not_folder_share'
              ? 'details.faceSearchNotFolder'
              : 'details.faceSearchNotIndexed',
        };
      }
      break;
    }
    case ErrorCode.PLAN_CHANGE_INVALID: {
      const d = planChangeInvalidDetailsSchema.safeParse(details);
      if (d.success) return { key: `planChange.${d.data.reason}` };
      break;
    }
    case ErrorCode.CHECKOUT_PENDING: {
      const d = checkoutPendingDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key: 'details.checkoutPending',
          values: {
            time: new Intl.DateTimeFormat(intl, {
              timeStyle: 'short',
              timeZone: TIME_ZONE,
            }).format(new Date(d.data.expiresAt)),
          },
        };
      }
      break;
    }
    case ErrorCode.COVER_FILE_INVALID: {
      const d = coverFileInvalidDetailsSchema.safeParse(details);
      if (d.success) return { key: `coverFile.${d.data.reason}` };
      break;
    }
    case ErrorCode.PASSWORD_TOO_WEAK: {
      const d = passwordTooWeakDetailsSchema.safeParse(details);
      if (d.success) return messageForPasswordPolicy(d.data.reason, d.data.minLength);
      break;
    }
    case ErrorCode.RATE_LIMITED: {
      // Face search and face deletion: a Turnstile challenge can unlock more attempts, or only
      // waiting helps (captcha null, or Cloudflare unreachable at the API).
      const d = rateLimitedDetailsSchema.safeParse(details);
      if (d.success) {
        const captcha = d.data.captcha;
        if (captcha !== null && captcha.rejected !== 'unavailable') {
          const keys = {
            none: 'details.captchaRequired',
            expired: 'details.captchaExpired',
            invalid: 'details.captchaInvalid',
          } as const;
          return { key: keys[captcha.rejected ?? 'none'] };
        }
        return {
          key: 'details.rateLimitedWait',
          values: { minutes: Math.max(1, Math.ceil(d.data.retryAfterSeconds / 60)) },
        };
      }
      break;
    }
    default:
      break;
  }
  return { key: `codes.${code}` };
}

/** The Thai text key of an informational billing notice (DOWNGRADE_EXCEEDS_QUOTA). */
export function messageForNotice(notice: BillingNotice, locale = 'th-TH'): ErrorMessage {
  return {
    key: `notices.${notice.code}`,
    values: {
      quota: formatBytes(notice.details.quotaBytes, locale),
      used: formatBytes(notice.details.usedBytes + notice.details.reservedBytes, locale),
      over: formatBytes(notice.details.overBytes, locale),
    },
  };
}

/** The message for anything thrown by the API client, the uploader or a local check. */
export function describeError(error: unknown, labels?: MessageLabels): ErrorMessage {
  if (error instanceof ApiError) return messageForCode(error.code, error.details, labels);
  if (error instanceof ClientError) return { key: error.key, values: error.values };
  if (error instanceof NetworkError) return { key: 'client.network' };
  if (error instanceof ContractError) return { key: 'client.contract' };
  return { key: 'client.unknown' };
}
