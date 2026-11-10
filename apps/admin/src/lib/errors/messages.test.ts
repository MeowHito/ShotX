import { ERROR_CODES, ErrorCode, PASSWORD_POLICY_REASONS } from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { th } from '@/messages/th';
import { ApiError, ContractError, NetworkError } from '../api/errors';
import { describeError, messageForCode } from './messages';

const t = createTranslator({ locale: 'th', messages: th, namespace: 'errors' });
const text = (code: ErrorCode, details?: unknown) => {
  const { key, values } = messageForCode(code, details);
  return t(key, values as never);
};

describe('error code → Thai message', () => {
  it('has Thai text for every API error code', () => {
    for (const code of ERROR_CODES) {
      const message = text(code);
      expect(message, code).toMatch(/[฀-๿]/);
      expect(message, code).not.toContain(code);
    }
  });

  it('explains the account-management refusals', () => {
    expect(text(ErrorCode.EMAIL_TAKEN)).toContain('อีเมลนี้มีบัญชีอยู่แล้ว');
    expect(text(ErrorCode.LAST_ADMIN)).toContain('แอดมินคนสุดท้าย');
    expect(text(ErrorCode.CANNOT_MODIFY_SELF)).toContain('บัญชีของตัวเอง');
    expect(text(ErrorCode.MFA_INVALID)).toContain('รหัสยืนยันตัวตนไม่ถูกต้อง');
    expect(text(ErrorCode.ACCOUNT_DISABLED)).toContain('ปิดใช้งาน');
  });

  it('says why a password is too weak, with the minimum length', () => {
    for (const reason of PASSWORD_POLICY_REASONS) {
      const message = text(ErrorCode.PASSWORD_TOO_WEAK, { reason, minLength: 14 });
      expect(message, reason).toContain('14');
    }
    expect(text(ErrorCode.PASSWORD_TOO_WEAK, { reason: 'too_short', minLength: 14 })).toBe(
      'รหัสผ่านสั้นเกินไป ต้องยาวอย่างน้อย 14 ตัวอักษร',
    );
    expect(
      text(ErrorCode.PASSWORD_TOO_WEAK, { reason: 'contains_email', minLength: 10 }),
    ).toContain('อีเมล');
    // Malformed details fall back to the code's general message.
    expect(text(ErrorCode.PASSWORD_TOO_WEAK, { reason: 'nope' })).toBe(
      th.errors.codes.PASSWORD_TOO_WEAK,
    );
  });

  it('tells how long to wait when a rate limit says so', () => {
    expect(text(ErrorCode.RATE_LIMITED, { retryAfterSeconds: 125, captcha: null })).toContain('3');
    expect(text(ErrorCode.RATE_LIMITED)).toBe(th.errors.codes.RATE_LIMITED);
  });

  it('describes client-side failures', () => {
    expect(describeError(new ApiError(409, ErrorCode.EMAIL_TAKEN, 'x', undefined))).toEqual({
      key: 'codes.EMAIL_TAKEN',
    });
    expect(describeError(new NetworkError('offline'))).toEqual({ key: 'client.network' });
    expect(describeError(new ContractError(200, 'bad'))).toEqual({ key: 'client.contract' });
    expect(describeError(new Error('?'))).toEqual({ key: 'client.unknown' });
  });
});
