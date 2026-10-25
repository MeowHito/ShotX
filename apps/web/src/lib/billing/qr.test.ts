import { describe, expect, it } from 'vitest';
import { encodeQr, qrSvgPath } from './qr';

const rows = (text: string) =>
  encodeQr(text).modules.map((r) => r.map((dark) => (dark ? '1' : '0')).join(''));

/**
 * "hello" as this encoder draws it (version 1-M). This matrix, and payloads of versions 6, 8, 13
 * and 29 including UTF-8 Thai text, were decoded back to their text with Apple's CoreImage QR
 * detector when the encoder was written; this known answer guards against regressions.
 */
const HELLO = [
  '111111100110001111111',
  '100000101100001000001',
  '101110100101101011101',
  '101110100011001011101',
  '101110101100101011101',
  '100000100000101000001',
  '111111101010101111111',
  '000000000011100000000',
  '101010100101000010010',
  '001011000010001000011',
  '010100101110100011111',
  '110010000000001000010',
  '011010110010101010000',
  '000000001111010100111',
  '111111100011011100111',
  '100000100011110110000',
  '101110101011011100011',
  '101110100100001100110',
  '101110101110100010101',
  '100000100100001010010',
  '111111101110101100011',
];

describe('QR encoder (PromptPay payloads)', () => {
  it('matches the verified known answer', () => {
    expect(rows('hello')).toEqual(HELLO);
  });

  it('picks the smallest version and draws finder and timing patterns', () => {
    const payload =
      '00020101021230570016A00000067701011201150105536006853270206REF00153037645406149.005802TH6304ABCD';
    const qr = encodeQr(payload);
    expect(qr.version).toBe(6);
    expect(qr.size).toBe(41);
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
    const at = (x: number, y: number) => (qr.modules[y]?.[x] ? '1' : '0');
    const block = (x0: number, y0: number) =>
      Array.from({ length: 7 }, (_, y) =>
        Array.from({ length: 7 }, (_, x) => at(x0 + x, y0 + y)).join(''),
      );
    expect(block(0, 0)).toEqual(finder);
    expect(block(qr.size - 7, 0)).toEqual(finder);
    expect(block(0, qr.size - 7)).toEqual(finder);
    for (let i = 8; i < qr.size - 8; i++) {
      expect(at(i, 6)).toBe(i % 2 === 0 ? '1' : '0');
      expect(at(6, i)).toBe(i % 2 === 0 ? '1' : '0');
    }
    // The dark module next to the bottom-left finder.
    expect(at(8, qr.size - 8)).toBe('1');
  });

  it('handles UTF-8 and refuses text beyond version 40', () => {
    expect(encodeQr('ทดสอบ').version).toBe(2); // 15 UTF-8 bytes: one over 1-M
    expect(() => encodeQr('x'.repeat(3000))).toThrow(RangeError);
  });

  it('renders one unit square per dark module, offset by the quiet zone', () => {
    const qr = encodeQr('hello');
    const dark = qr.modules.flat().filter(Boolean).length;
    const path = qrSvgPath(qr, 4);
    expect(path.match(/M/g)).toHaveLength(dark);
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
