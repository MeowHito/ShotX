import {
  ErrorCode,
  fileTooLargeDetailsSchema,
  folderDepthExceededDetailsSchema,
  nameTakenDetailsSchema,
  quotaExceededDetailsSchema,
  subscriptionInactiveDetailsSchema,
  unsupportedFileTypeDetailsSchema,
} from '@shotx/shared';
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

/** The message for an error code and its (untrusted) details. */
export function messageForCode(
  code: ErrorCode,
  details: unknown,
  labels: { subscriptionStatus: (status: string) => string } = { subscriptionStatus: (s) => s },
): ErrorMessage {
  switch (code) {
    case ErrorCode.QUOTA_EXCEEDED: {
      const d = quotaExceededDetailsSchema.safeParse(details);
      if (d.success) {
        return {
          key: 'details.quotaExceeded',
          values: {
            requested: formatBytes(d.data.requestedBytes),
            available: formatBytes(d.data.availableBytes),
          },
        };
      }
      break;
    }
    case ErrorCode.FILE_TOO_LARGE: {
      const d = fileTooLargeDetailsSchema.safeParse(details);
      if (d.success) {
        return { key: 'details.fileTooLarge', values: { max: formatBytes(d.data.maxBytes) } };
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
    default:
      break;
  }
  return { key: `codes.${code}` };
}

/** The message for anything thrown by the API client, the uploader or a local check. */
export function describeError(
  error: unknown,
  labels?: { subscriptionStatus: (status: string) => string },
): ErrorMessage {
  if (error instanceof ApiError) return messageForCode(error.code, error.details, labels);
  if (error instanceof ClientError) return { key: error.key, values: error.values };
  if (error instanceof NetworkError) return { key: 'client.network' };
  if (error instanceof ContractError) return { key: 'client.contract' };
  return { key: 'client.unknown' };
}
