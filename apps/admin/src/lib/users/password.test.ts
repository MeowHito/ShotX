import { passwordPolicyViolation } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { generatePassword, PASSWORD_ALPHABET } from './password';

describe('generatePassword', () => {
  it('makes passwords of the asked length from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const password = generatePassword(20);
      expect(password).toHaveLength(20);
      expect([...password].every((c) => PASSWORD_ALPHABET.includes(c))).toBe(true);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).not.toMatch(/[0O1lI]/);
      expect(passwordPolicyViolation(password, { minLength: 16 })).toBeNull();
    }
  });

  it('never accepts fewer than 16 characters', () => {
    expect(() => generatePassword(15)).toThrow(RangeError);
    expect(generatePassword(16)).toHaveLength(16);
  });

  it('uses crypto.getRandomValues', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    generatePassword(16);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects biased bytes instead of folding them (no modulo bias)', () => {
    // 57 characters: bytes ≥ 228 (= 256 - 256 % 57) must be skipped, never folded with `% 57`.
    expect(PASSWORD_ALPHABET).toHaveLength(57);
    const good = [0, 25, 49, 3, 30, 52, 7, 40, 10, 55, 12, 33, 20, 45, 5, 27];
    const bytes = [255, 250, 228, ...good];
    let i = 0;
    const random = (buffer: Uint8Array) => {
      buffer[0] = bytes[i++] as number;
      return buffer;
    };
    const password = generatePassword(16, { random });
    expect(password).toBe(good.map((b) => PASSWORD_ALPHABET[b]).join(''));
  });

  it('never contains the account email', () => {
    for (let i = 0; i < 20; i++) {
      const password = generatePassword(16, { email: 'abc@example.com' });
      expect(
        passwordPolicyViolation(password, { minLength: 16, email: 'abc@example.com' }),
      ).toBeNull();
    }
  });
});
