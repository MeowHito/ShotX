import { ERROR_CODES, ErrorCode, REJECTED_FILE_TYPE_HINTS } from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { th } from '../../messages/th';
import { ApiError, ContractError, NetworkError } from '../api/errors';
import { ClientError, describeError, type ErrorMessage, messageForCode } from './messages';

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
