import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { type ApiErrorBody, type ErrorCode, ERROR_HTTP_STATUS } from '@shotx/shared';
import type { Request, Response } from 'express';
import { ApiError } from './api-error';

/** Nest's own HTTP exceptions (unknown route, ...) mapped to stable codes. */
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

const GENERIC_MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  VALIDATION_FAILED: 'Request validation failed',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'Internal server error',
};

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  headers: Record<string, string>;
}

/**
 * The response for any thrown value. Only ApiError carries a message and details to the client;
 * everything else becomes a generic body, so stack traces, SQL and driver messages never leak.
 */
export function errorResponse(error: unknown): ErrorResponse {
  if (error instanceof ApiError) {
    const body: ApiErrorBody = { code: error.code, message: error.message };
    if (error.details !== undefined) body.details = error.details;
    return { status: error.status, body, headers: { ...error.headers } };
  }
  if (error instanceof HttpException) {
    const code = CODE_BY_STATUS[error.getStatus()] ?? 'INTERNAL_ERROR';
    const body: ApiErrorBody = { code, message: GENERIC_MESSAGES[code] ?? 'Error' };
    if (code === 'VALIDATION_FAILED') body.details = { issues: [] };
    return { status: ERROR_HTTP_STATUS[code], body, headers: {} };
  }
  return {
    status: ERROR_HTTP_STATUS.INTERNAL_ERROR,
    body: { code: 'INTERNAL_ERROR', message: GENERIC_MESSAGES.INTERNAL_ERROR ?? 'Error' },
    headers: {},
  };
}

const MAX_LOGGED_MESSAGE = 200;

/** The first PostgreSQL error (5-character SQLSTATE `code`) in an error's `cause` chain. */
function pgErrorIn(error: unknown): (Error & { code: string }) | null {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e instanceof Error; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code))
      return e as Error & { code: string };
    e = e.cause;
  }
  return null;
}

/**
 * A message safe to log: the first line only (Drizzle appends the SQL and its `params` on later
 * lines), with quoted values, emails, numbers and long tokens replaced. File names, S3 keys,
 * emails and ids from parameters or driver messages (`invalid input syntax for type uuid: "…"`)
 * never reach the logs.
 */
export function scrubMessage(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? '';
  if (/^Failed query:/i.test(firstLine)) return 'query failed';
  return firstLine
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '?')
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '(?)=(?)')
    .replace(/[^\s@]+@[^\s@]+/g, '?')
    .replace(/[A-Za-z0-9_\-./+=]{24,}/g, '?')
    .replace(/\d+/g, '?')
    .slice(0, MAX_LOGGED_MESSAGE);
}

/**
 * What the filter logs for an unexpected error: the error class, the PostgreSQL error code (and
 * constraint name) when there is one, and a scrubbed message. Never the stack, the SQL, its
 * parameters, the request body or headers.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error thrown';
  const pg = pgErrorIn(error);
  const parts = [error.constructor.name || error.name];
  if (pg !== null) {
    parts.push(`pg=${pg.code}`);
    const constraint = (pg as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(constraint)) {
      parts.push(`constraint=${constraint}`);
    }
  }
  parts.push(scrubMessage((pg ?? error).message));
  return parts.join(' ');
}

/**
 * The global exception filter. Logs unexpected errors with the route pattern and describeError
 * only: never the request body, query values, headers, tokens, SQL parameters or stacks (selfies,
 * file names, emails and credentials must not reach logs).
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const { status, body, headers } = errorResponse(exception);
    if (status >= 500) {
      const route = (req.route as { path?: string } | undefined)?.path ?? '(unmatched)';
      this.logger.error(
        `${req.method} ${route} failed: ${describeError(exception)}`,
        'ApiExceptionFilter',
      );
    }
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).json(body);
  }
}
