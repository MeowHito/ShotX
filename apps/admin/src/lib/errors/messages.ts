import { ErrorCode, passwordTooWeakDetailsSchema, rateLimitedDetailsSchema } from '@shotx/shared';
import type { Messages } from '../../messages/th';
import { ApiError, ContractError, NetworkError } from '../api/errors';

/**
 * The one place that turns errors into Thai copy (keys under the `errors` namespace). Every API
 * ErrorCode has a message in `errors.codes`; codes with typed details get a more specific one:
 * PASSWORD_TOO_WEAK says why and the minimum length, RATE_LIMITED how long to wait when known.
 * EMAIL_TAKEN, LAST_ADMIN and CANNOT_MODIFY_SELF are explained in `errors.codes`.
 */

type Errors = Messages['errors'];

export type ErrorMessageKey =
  | `codes.${keyof Errors['codes']}`
  | `passwordPolicy.${keyof Errors['passwordPolicy']}`
  | 'rateLimitedWait'
  | `client.${keyof Errors['client']}`;

export interface ErrorMessage {
  key: ErrorMessageKey;
  values?: Record<string, string | number>;
}

/** The message for an error code and its (untrusted) details. */
export function messageForCode(code: ErrorCode, details: unknown): ErrorMessage {
  switch (code) {
    case ErrorCode.PASSWORD_TOO_WEAK: {
      const d = passwordTooWeakDetailsSchema.safeParse(details);
      if (d.success) {
        return { key: `passwordPolicy.${d.data.reason}`, values: { minLength: d.data.minLength } };
      }
      break;
    }
    case ErrorCode.RATE_LIMITED: {
      const d = rateLimitedDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key: 'rateLimitedWait',
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

/** The message for anything thrown by the API client or the sign-in calls. */
export function describeError(error: unknown): ErrorMessage {
  if (error instanceof ApiError) return messageForCode(error.code, error.details);
  if (error instanceof NetworkError) return { key: 'client.network' };
  if (error instanceof ContractError) return { key: 'client.contract' };
  return { key: 'client.unknown' };
}
