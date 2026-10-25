import { type ErrorCode, ERROR_HTTP_STATUS } from '@shotx/shared';

/**
 * An error the API answers with `{ code, message, details }`. `message` is English for developers;
 * the web app shows Thai text mapped from `code`. `details` must match the code's schema in
 * ERROR_DETAILS_SCHEMAS (or be absent) and never echo request values.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  /** Extra response headers, e.g. Retry-After for RATE_LIMITED. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.headers = headers;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export const notFound = (what = 'Resource') => new ApiError('NOT_FOUND', `${what} not found`);
