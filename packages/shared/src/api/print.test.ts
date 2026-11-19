import { describe, expect, it } from 'vitest';
import {
  createPrintOrderBodySchema,
  PRINT_DEVICE_LIMIT_MAX,
  printPrintOrderBodySchema,
  printSettingsSchema,
  sortPaperSizes,
} from './print';

const fileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';

describe('print orders (ADR 0031)', () => {
  it('keeps paper sizes in table order and refuses repeats or none', () => {
    const base = { enabled: true, approval: 'auto', perDeviceLimit: 2 } as const;
    expect(printSettingsSchema.parse({ ...base, paperSizes: ['a4', '4r'] }).paperSizes).toEqual([
      '4r',
      'a4',
    ]);
    expect(printSettingsSchema.safeParse({ ...base, paperSizes: ['4r', '4r'] }).success).toBe(
      false,
    );
    expect(printSettingsSchema.safeParse({ ...base, paperSizes: [] }).success).toBe(false);
    expect(printSettingsSchema.safeParse({ ...base, paperSizes: ['9x9'] }).success).toBe(false);
  });

  it('bounds the per-device limit', () => {
    const base = { enabled: true, approval: 'manual', paperSizes: ['4r'] } as const;
    expect(printSettingsSchema.safeParse({ ...base, perDeviceLimit: 0 }).success).toBe(false);
    expect(
      printSettingsSchema.safeParse({ ...base, perDeviceLimit: PRINT_DEVICE_LIMIT_MAX }).success,
    ).toBe(true);
    expect(
      printSettingsSchema.safeParse({ ...base, perDeviceLimit: PRINT_DEVICE_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it('trims the customer name and turns an empty one into null', () => {
    expect(
      createPrintOrderBodySchema.parse({ fileId, paperSize: '5r', customerName: '  บิบ 123 ' })
        .customerName,
    ).toBe('บิบ 123');
    expect(
      createPrintOrderBodySchema.parse({ fileId, paperSize: '5r', customerName: '   ' })
        .customerName,
    ).toBeNull();
    expect(createPrintOrderBodySchema.parse({ fileId, paperSize: '5r' }).customerName).toBeNull();
    expect(
      createPrintOrderBodySchema.safeParse({
        fileId,
        paperSize: '5r',
        customerName: 'x'.repeat(61),
      }).success,
    ).toBe(false);
  });

  it('prints only queued orders for a station', () => {
    expect(printPrintOrderBodySchema.parse({})).toEqual({ onlyQueued: false });
    expect(sortPaperSizes(['a4', '5r'])).toEqual(['5r', 'a4']);
  });
});
