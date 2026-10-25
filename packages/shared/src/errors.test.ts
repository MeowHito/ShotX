import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ApiErrorBody,
  apiErrorBodySchema,
  ERROR_CODES,
  ERROR_DETAILS_SCHEMAS,
  ERROR_HTTP_STATUS,
  ErrorCode,
  validationFailedDetails,
  validationFailedDetailsSchema,
} from './errors';

describe('ErrorCode', () => {
  it('maps every code to itself, so clients can switch on the string', () => {
    for (const [key, value] of Object.entries(ErrorCode)) expect(value).toBe(key);
  });

  it('has the codes the API, the WAF and Phase 2 drive and uploads return', () => {
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        'QUOTA_EXCEEDED',
        'SHARE_EXPIRED',
        'CONSENT_REQUIRED',
        'NO_FACE_DETECTED',
        'RATE_LIMITED',
        'PAYLOAD_TOO_LARGE',
        'UNSUPPORTED_FILE_TYPE',
        'FILE_TOO_LARGE',
        'VALIDATION_FAILED',
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'NOT_FOUND',
        'CONFLICT',
        'INTERNAL_ERROR',
        'NAME_TAKEN',
        'INVALID_MOVE',
        'FOLDER_DEPTH_EXCEEDED',
        'SUBSCRIPTION_INACTIVE',
        'UPLOAD_NOT_FOUND',
        'UPLOAD_EXPIRED',
        'UPLOAD_PARTS_INVALID',
      ]),
    );
  });

  it('gives every code an HTTP error status', () => {
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const status of Object.values(ERROR_HTTP_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    // The WAF answers 413 and 429 with these codes (infra/lib/constructs/waf-rules.ts).
    expect(ERROR_HTTP_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
    expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
  });

  it('types and validates the error body', () => {
    // The WAF's 413 body (infra/lib/constructs/waf-rules.ts) is a valid ApiErrorBody.
    const waf: ApiErrorBody = {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Payload too large',
      details: {},
    };
    expect(apiErrorBodySchema.parse(waf)).toEqual(waf);
    expect(apiErrorBodySchema.safeParse({ code: 'NOPE', message: 'x' }).success).toBe(false);
    expectTypeOf<'FILE_TOO_LARGE'>().toExtend<ErrorCode>();
  });

  it('has a details schema only for codes that exist', () => {
    for (const code of Object.keys(ERROR_DETAILS_SCHEMAS)) expect(ERROR_CODES).toContain(code);
    expect(
      ERROR_DETAILS_SCHEMAS.QUOTA_EXCEEDED.parse({
        quotaBytes: 10,
        usedBytes: 8,
        reservedBytes: 1,
        requestedBytes: 5,
        availableBytes: 1,
      }),
    ).toBeTruthy();
  });

  it('builds VALIDATION_FAILED details from a zod error without echoing values', () => {
    const result = z
      .object({ items: z.array(z.object({ id: z.uuid() })) })
      .safeParse({ items: [{ id: 'secret-value' }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const details = validationFailedDetails('body', result.error);
    expect(validationFailedDetailsSchema.parse(details)).toEqual(details);
    expect(details.issues[0]?.path).toEqual(['body', 'items', 0, 'id']);
    expect(JSON.stringify(details)).not.toContain('secret-value');
  });
});
