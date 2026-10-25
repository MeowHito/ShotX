import express, { type RequestHandler } from 'express';
import type { ApiLimits } from '../config';
import { ApiError } from './api-error';
import { errorResponse } from './exception.filter';

/** `POST /api/uploads/:id/complete` carries every part's ETag, so it gets a larger limit. */
const COMPLETE_PATH = /^\/api\/uploads\/[^/]+\/complete$/;

/**
 * `POST /api/billing/webhooks/:gateway` (RouteContract.rawBody): the exact bytes, unparsed, because
 * the gateway's signature covers them. Same limit as JSON bodies.
 */
export const WEBHOOK_PATH = /^\/api\/billing\/webhooks\/[^/]+$/;

/** The raw webhook body the middleware kept (empty when none was sent). */
export function rawBodyOf(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}

/**
 * JSON body parsing with a limit per route (file bytes never reach the API, so every body is
 * small). Parse failures answer VALIDATION_FAILED and oversized bodies PAYLOAD_TOO_LARGE in the
 * API's error format; the body itself is never logged. Other content types are not parsed and
 * fail the route's schema. Webhook bodies are read raw, whatever their content type.
 */
export function jsonBodyMiddleware(limits: ApiLimits): RequestHandler {
  const small = express.json({ limit: limits.jsonBodyMaxBytes, strict: true });
  const large = express.json({ limit: limits.completeBodyMaxBytes, strict: true });
  const raw = express.raw({ limit: limits.jsonBodyMaxBytes, type: () => true });
  return (req, res, next) => {
    const parser = WEBHOOK_PATH.test(req.path) ? raw : COMPLETE_PATH.test(req.path) ? large : small;
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
