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

/**
 * The global exception filter. Logs unexpected errors with the route pattern only: never the
 * request body, query values, headers or tokens (selfies and credentials must not reach logs).
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
      const detail =
        exception instanceof Error ? (exception.stack ?? exception.message) : 'non-error thrown';
      this.logger.error(`${req.method} ${route} failed: ${detail}`, 'ApiExceptionFilter');
    }
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).json(body);
  }
}
