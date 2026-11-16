import {
  COVER_FILE_INVALID_REASONS,
  ERROR_CODES,
  ErrorCode,
  PASSWORD_POLICY_REASONS,
  PLAN_CHANGE_INVALID_REASONS,
  REJECTED_FILE_TYPE_HINTS,
  SHARE_UNAVAILABLE_REASONS,
} from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { th } from '../../messages/th';
import { ApiError, ContractError, NetworkError } from '../api/errors';
import {
  ClientError,
  describeError,
  type ErrorMessage,
  messageForCode,
  messageForNotice,
  messageForPasswordPolicy,
} from './messages';

const t = createTranslator({ locale: 'th', messages: th, namespace: 'errors' });
const render = (m: ErrorMessage) => t(m.key, m.values as never);

describe('error message map', () => {
  it('has a Thai message for every ErrorCode and nothing else', () => {
    expect(Object.keys(th.errors.codes).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const text = th.errors.codes[code];
      expect(text, code).toMatch(/[฀-๿]/);
    }
  });

  it('falls back to the code message when details are missing or malformed', () => {
    for (const code of ERROR_CODES) {
      expect(messageForCode(code, undefined)).toEqual({ key: `codes.${code}` });
      expect(messageForCode(code, { nonsense: true })).toEqual({ key: `codes.${code}` });
    }
  });

  it('uses typed details for specific messages', () => {
    expect(
      render(
        messageForCode(ErrorCode.QUOTA_EXCEEDED, {
          quotaBytes: 10 * 1024 ** 3,
          usedBytes: 9 * 1024 ** 3,
          reservedBytes: 0,
          requestedBytes: 2 * 1024 ** 3,
          availableBytes: 1024 ** 3,
        }),
      ),
    ).toBe('พื้นที่ไม่พอ ไฟล์นี้ต้องใช้ 2 GB แต่เหลือ 1 GB');
    expect(render(messageForCode(ErrorCode.FILE_TOO_LARGE, { maxBytes: 100 * 1024 ** 2 }))).toBe(
      'ไฟล์ใหญ่เกินกำหนด (สูงสุด 100 MB)',
    );
    expect(
      render(messageForCode(ErrorCode.NAME_TAKEN, { kind: 'folder', name: 'งานวิ่ง' })),
    ).toContain('“งานวิ่ง”');
    expect(render(messageForCode(ErrorCode.FOLDER_DEPTH_EXCEEDED, { maxDepth: 32 }))).toContain(
      '32',
    );
    expect(
      render(
        messageForCode(
          ErrorCode.SUBSCRIPTION_INACTIVE,
          { status: 'grace' },
          {
            subscriptionStatus: (s) => th.usage.subscriptionStatus[s as 'grace'],
          },
        ),
      ),
    ).toContain('ช่วงผ่อนผัน');
    expect(messageForCode(ErrorCode.SUBSCRIPTION_INACTIVE, { status: null }).key).toBe(
      'details.subscriptionNone',
    );
  });

  it('maps RATE_LIMITED details: a challenge, why a token was refused, or how long to wait', () => {
    const limited = (captcha: unknown, retryAfterSeconds = 61) =>
      render(messageForCode(ErrorCode.RATE_LIMITED, { retryAfterSeconds, captcha }));
    const offer = (rejected: string | null) => ({
      provider: 'turnstile',
      action: 'face_search',
      rejected,
    });
    expect(limited(offer(null))).toBe(th.errors.details.captchaRequired);
    expect(limited(offer('expired'))).toBe(th.errors.details.captchaExpired);
    expect(limited(offer('invalid'))).toBe(th.errors.details.captchaInvalid);
    expect(limited(offer('unavailable'))).toBe('ส่งคำขอบ่อยเกินไป กรุณารออีก 2 นาทีแล้วลองใหม่');
    expect(limited(null, 0)).toBe('ส่งคำขอบ่อยเกินไป กรุณารออีก 1 นาทีแล้วลองใหม่');
    expect(limited(null, 600)).toBe('ส่งคำขอบ่อยเกินไป กรุณารออีก 10 นาทีแล้วลองใหม่');
  });

  it('says "ลิงก์นี้หมดอายุ" for every SHARE_EXPIRED reason', () => {
    for (const reason of SHARE_UNAVAILABLE_REASONS) {
      const text = render(messageForCode(ErrorCode.SHARE_EXPIRED, { reason }));
      // ADR 0016: an unpublished event isn't expired; the same link opens again later. ADR 0026:
      // neither is a link whose photographer's package ran out (it opens again on renewal).
      if (reason === 'paused') expect(text).toContain('ลิงก์นี้ยังไม่เปิดให้ดู');
      else if (reason === 'plan_expired')
        expect(text).toBe('ลิงก์นี้ปิดชั่วคราว ลองเปิดอีกครั้งภายหลัง');
      else expect(text, reason).toContain('ลิงก์นี้หมดอายุ');
    }
    expect(render(messageForCode(ErrorCode.SHARE_EXPIRED, undefined))).toBe('ลิงก์นี้หมดอายุ');
  });

  it('gives the Phase 3 codes their detail messages', () => {
    expect(
      render(
        messageForCode(ErrorCode.ZIP_TOO_LARGE, {
          maxFiles: 500,
          maxBytes: 2 * 1024 ** 3,
          files: 600,
          bytes: 3 * 1024 ** 3,
        }),
      ),
    ).toBe('ดาวน์โหลดพร้อมกันได้ไม่เกิน 500 รูป และรวมไม่เกิน 2 GB (เลือกไว้ 600 รูป 3 GB)');
    expect(
      render(messageForCode(ErrorCode.NO_FACE_DETECTED, { selfies: 2, selfiesWithoutFace: 2 })),
    ).toBe('ไม่พบใบหน้าในรูปที่ส่ง (2 รูป)');
    expect(
      messageForCode(ErrorCode.FACE_SEARCH_UNAVAILABLE, { reason: 'not_folder_share' }).key,
    ).toBe('details.faceSearchNotFolder');
    expect(messageForCode(ErrorCode.FACE_SEARCH_UNAVAILABLE, { reason: 'not_indexed' }).key).toBe(
      'details.faceSearchNotIndexed',
    );
    expect(render(messageForCode(ErrorCode.PASSWORD_INCORRECT, undefined))).toBe(
      'รหัสผ่านไม่ถูกต้อง',
    );
  });

  it('gives the package codes (ADR 0026) Thai messages, with their details', () => {
    expect(
      render(messageForCode(ErrorCode.PLAN_EXPIRED, { expiresAt: '2026-11-20T05:00:00.000Z' })),
    ).toMatch(/^แพ็กเกจหมดอายุเมื่อ .*2569.* ต่ออายุแพ็กเกจเพื่อใช้งานต่อ$/);
    expect(
      render(
        messageForCode(ErrorCode.PHOTO_LIMIT_REACHED, {
          photoLimit: 1000,
          photosUsed: 1000,
          requested: 1,
        }),
      ),
    ).toBe('อัปโหลดครบ 1,000 ภาพตามแพ็กเกจแล้ว ต่ออายุหรือเลือกแพ็กเกจเพิ่มเพื่ออัปโหลดต่อ');
    expect(render(messageForCode(ErrorCode.PAYMENT_UNAVAILABLE, undefined))).toBe(
      'ระบบชำระเงินออนไลน์จะเปิดใช้งานเร็วๆ นี้ กรุณาติดต่อทีมงาน',
    );
    for (const code of [
      ErrorCode.PACKAGE_UNAVAILABLE,
      ErrorCode.EMAIL_UNAVAILABLE,
      ErrorCode.SIGNUP_LINK_INVALID,
      ErrorCode.ORDER_NOT_FOUND,
    ]) {
      expect(render(messageForCode(code, undefined)), code).toBe(th.errors.codes[code]);
    }
  });

  it('gives the billing codes Thai messages, with reasons and pending details', () => {
    for (const code of [
      ErrorCode.PLAN_NOT_FOUND,
      ErrorCode.PLAN_CHANGE_INVALID,
      ErrorCode.CHECKOUT_PENDING,
      ErrorCode.CHECKOUT_EXPIRED,
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      ErrorCode.PAYMENT_GATEWAY_ERROR,
    ]) {
      expect(render(messageForCode(code, undefined)), code).toMatch(/[฀-๿]/);
    }
    for (const reason of PLAN_CHANGE_INVALID_REASONS) {
      const m = messageForCode(ErrorCode.PLAN_CHANGE_INVALID, {
        reason,
        expectedChangeType: 'new',
      });
      expect(m.key).toBe(`planChange.${reason}`);
      expect(render(m)).toBe(th.errors.planChange[reason]);
    }
    expect(
      render(
        messageForCode(ErrorCode.CHECKOUT_PENDING, {
          paymentId: null,
          expiresAt: '2026-10-25T05:15:00.000Z',
        }),
      ),
    ).toContain('หมดเวลา 12:15');
  });

  it('gives the account codes (ADR 0010) Thai messages', () => {
    expect(render(messageForCode(ErrorCode.PASSWORD_CHANGE_REQUIRED, undefined))).toContain(
      'ตั้งรหัสผ่านใหม่',
    );
    expect(render(messageForCode(ErrorCode.ACCOUNT_DISABLED, undefined))).toBe(
      'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
    );
    expect(render(messageForCode(ErrorCode.INVALID_CREDENTIALS, undefined))).toBe(
      'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    );
    for (const code of [
      ErrorCode.EMAIL_TAKEN,
      ErrorCode.LAST_ADMIN,
      ErrorCode.CANNOT_MODIFY_SELF,
      ErrorCode.PASSWORD_TOO_WEAK,
    ]) {
      expect(render(messageForCode(code, undefined)), code).toMatch(/[฀-๿]/);
    }
  });

  it('says why a file can\u2019t be the folder cover (COVER_FILE_INVALID)', () => {
    for (const reason of COVER_FILE_INVALID_REASONS) {
      const m = messageForCode(ErrorCode.COVER_FILE_INVALID, { reason });
      expect(m.key).toBe(`coverFile.${reason}`);
      expect(render(m)).toBe(th.errors.coverFile[reason]);
    }
    expect(render(messageForCode(ErrorCode.COVER_FILE_INVALID, undefined))).toBe(
      'ใช้รูปนี้เป็นภาพปกไม่ได้',
    );
  });

  it('explains LOGIN_PROVIDER_UNAVAILABLE (require login without LINE/Google)', () => {
    const text = render(messageForCode(ErrorCode.LOGIN_PROVIDER_UNAVAILABLE, undefined));
    expect(text).toContain('LINE หรือ Google');
    expect(text).toContain('ต้องเข้าสู่ระบบก่อนดูไม่ได้');
  });

  it('says why a new password is too weak, with the minimum length', () => {
    for (const reason of PASSWORD_POLICY_REASONS) {
      const m = messageForCode(ErrorCode.PASSWORD_TOO_WEAK, { reason, minLength: 12 });
      expect(m).toEqual(messageForPasswordPolicy(reason, 12));
      expect(m.key).toBe(`passwordPolicy.${reason}`);
      expect(render(m), reason).toMatch(/[฀-๿]/);
    }
    expect(
      render(messageForCode(ErrorCode.PASSWORD_TOO_WEAK, { reason: 'too_short', minLength: 12 })),
    ).toBe('รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร');
    expect(
      render(
        messageForCode(ErrorCode.PASSWORD_TOO_WEAK, { reason: 'same_as_current', minLength: 10 }),
      ),
    ).toBe('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน');
    // A wrong current password is PASSWORD_INCORRECT; a locked account is RATE_LIMITED.
    expect(render(messageForCode(ErrorCode.PASSWORD_INCORRECT, undefined))).toBe(
      'รหัสผ่านไม่ถูกต้อง',
    );
    expect(
      render(messageForCode(ErrorCode.RATE_LIMITED, { retryAfterSeconds: 900, captcha: null })),
    ).toBe('ส่งคำขอบ่อยเกินไป กรุณารออีก 15 นาทีแล้วลองใหม่');
  });

  it('maps the DOWNGRADE_EXCEEDS_QUOTA notice', () => {
    const m = messageForNotice({
      code: 'DOWNGRADE_EXCEEDS_QUOTA',
      details: {
        quotaBytes: 10 * 1024 ** 3,
        usedBytes: 18 * 1024 ** 3,
        reservedBytes: 2 * 1024 ** 3,
        overBytes: 10 * 1024 ** 3,
      },
    });
    expect(render(m)).toContain(
      'แพ็กเกจใหม่มีพื้นที่ 10 GB แต่ตอนนี้คุณใช้อยู่ 20 GB (เกิน 10 GB)',
    );
    expect(render(m)).toContain('ระบบจะไม่ลบไฟล์ของคุณ');
  });

  it('gives HEIC and RAW their hint messages', () => {
    for (const hint of REJECTED_FILE_TYPE_HINTS) {
      const m = messageForCode(ErrorCode.UNSUPPORTED_FILE_TYPE, { extension: hint, hint });
      expect(m.key).toBe(`hints.${hint}`);
      expect(render(m)).toBe(th.errors.hints[hint]);
    }
    expect(
      render(messageForCode(ErrorCode.UNSUPPORTED_FILE_TYPE, { extension: 'gif', hint: null })),
    ).toContain('.gif');
  });

  it('maps client-side failures', () => {
    expect(describeError(new NetworkError('x')).key).toBe('client.network');
    expect(describeError(new ContractError(200, 'x')).key).toBe('client.contract');
    expect(describeError(new ClientError('client.emptyFile')).key).toBe('client.emptyFile');
    expect(describeError(new Error('boom')).key).toBe('client.unknown');
    expect(describeError(new ApiError(404, 'NOT_FOUND', 'x', undefined)).key).toBe(
      'codes.NOT_FOUND',
    );
  });
});

describe('share page designer errors (ADR 0013)', () => {
  it('have short Thai messages, specific ones from their details', () => {
    expect(th.errors.codes.DESIGN_REVISION_CONFLICT).toContain('โหลดใหม่');
    expect(render(messageForCode(ErrorCode.DESIGN_LIMIT_REACHED, { maxDesigns: 50 }))).toBe(
      'สร้างดีไซน์ได้สูงสุด 50 แบบ ลบแบบที่ไม่ใช้ก่อนสร้างใหม่',
    );
    expect(
      render(
        messageForCode(ErrorCode.DESIGN_DOC_TOO_LARGE, { reason: 'elements', max: 60, actual: 61 }),
      ),
    ).toBe('ดีไซน์มีองค์ประกอบได้ไม่เกิน 60 ชิ้น (ตอนนี้ 61) ลบบางชิ้นออกก่อน');
    expect(
      messageForCode(ErrorCode.DESIGN_DOC_TOO_LARGE, {
        reason: 'bytes',
        max: 65536,
        actual: 70000,
      }),
    ).toEqual({ key: 'details.designTooManyBytes' });
    expect(messageForCode(ErrorCode.DESIGN_NOT_FOUND, undefined)).toEqual({
      key: 'codes.DESIGN_NOT_FOUND',
    });
    expect(describeError(new ClientError('client.designAssetFailed'))).toEqual({
      key: 'client.designAssetFailed',
    });
  });
});
