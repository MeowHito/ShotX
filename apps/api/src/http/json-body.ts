import express, { type RequestHandler } from 'express';
import type { ApiLimits } from '../config';
import { ApiError } from './api-error';
import { errorResponse } from './exception.filter';

/** `POST /api/uploads/:id/complete` carries every part's ETag, so it gets a larger limit. */
const COMPLETE_PATH = /^\/api\/uploads\/[^/]+\/complete$/;

/**
 * JSON body parsing with a limit per route (file bytes never reach the API, so every body is
 * small). Parse failures answer VALIDATION_FAILED and oversized bodies PAYLOAD_TOO_LARGE in the
 * API's error format; the body itself is never logged. Other content types are not parsed and
 * fail the route's schema.
 */
export function jsonBodyMiddleware(limits: ApiLimits): RequestHandler {
  const small = express.json({ limit: limits.jsonBodyMaxBytes, strict: true });
  const large = express.json({ limit: limits.completeBodyMaxBytes, strict: true });
  return (req, res, next) => {
    const parser = COMPLETE_PATH.test(req.path) ? large : small;
    void parser(req, res, (error?: unknown) => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      const type = (error as { type?: unknown }).type;
      const apiError =
        type === 'entity.too.large'
          ? new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large')
          : new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON', {
              issues: [{ path: ['body'], message: 'must be valid JSON' }],
            });
      const { status, body } = errorResponse(apiError);
      res.status(status).json(body);
    });
  };
}
