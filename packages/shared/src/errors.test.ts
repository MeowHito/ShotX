import { describe, expect, expectTypeOf, it } from 'vitest';
import { type ApiErrorBody, ErrorCode } from './errors';

describe('ErrorCode', () => {
  it('maps every code to itself, so clients can switch on the string', () => {
    for (const [key, value] of Object.entries(ErrorCode)) expect(value).toBe(key);
  });

  it('has the codes the API, the WAF and Phase 2 uploads return', () => {
    expect(Object.values(ErrorCode)).toEqual(
      expect.arrayContaining([
        'QUOTA_EXCEEDED',
        'SHARE_EXPIRED',
        'CONSENT_REQUIRED',
        'NO_FACE_DETECTED',
        'RATE_LIMITED',
        'PAYLOAD_TOO_LARGE',
        'UNSUPPORTED_FILE_TYPE',
        'FILE_TOO_LARGE',
      ]),
    );
  });

  it('types the error body', () => {
    // The WAF's 413 body (infra/lib/constructs/waf-rules.ts) is a valid ApiErrorBody.
    const waf: ApiErrorBody = {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Payload too large',
      details: {},
    };
    expect(waf.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expectTypeOf<'FILE_TOO_LARGE'>().toExtend<ErrorCode>();
  });
});
