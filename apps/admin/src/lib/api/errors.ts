import { apiErrorBodySchema, type ErrorCode } from '@shotx/shared';

/** An error response from the API: `{ code, message, details }` with a stable code. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

/** The request never got an HTTP response (offline, DNS, aborted connection). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

/**
 * The API answered with something the contract doesn't allow: a body that fails the route's
 * response schema, or an error body without a known code.
 */
export class ContractError extends Error {
  override readonly name = 'ContractError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Builds the error for a non-2xx response. */
export function errorFromResponse(status: number, body: unknown): ApiError | ContractError {
  const parsed = apiErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return new ContractError(status, `Unexpected error body (HTTP ${status})`);
  }
  return new ApiError(status, parsed.data.code, parsed.data.message, parsed.data.details);
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}
