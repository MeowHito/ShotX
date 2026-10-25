import { describe, expect, it } from 'vitest';
import { faceCollectionId, isValidCollectionId } from './collection';

describe('faceCollectionId', () => {
  it('prefixes the photographer id with pg-', () => {
    expect(faceCollectionId('0b6f3a52-5d0e-4c1b-9f43-2f1d7a6c9e10')).toBe(
      'pg-0b6f3a52-5d0e-4c1b-9f43-2f1d7a6c9e10',
    );
    expect(faceCollectionId('42')).toBe('pg-42');
  });

  it('rejects ids that break the Rekognition collection id rules', () => {
    for (const id of ['', 'a/b', 'a b', 'ผู้ใช้', 'x'.repeat(253), 'id\n']) {
      expect(() => faceCollectionId(id)).toThrow(RangeError);
    }
    expect(faceCollectionId('x'.repeat(252))).toHaveLength(255);
  });
});

describe('isValidCollectionId', () => {
  it('accepts 1–255 characters from [a-zA-Z0-9_.-]', () => {
    expect(isValidCollectionId('pg-A_b.9')).toBe(true);
    expect(isValidCollectionId('')).toBe(false);
    expect(isValidCollectionId('pg:1')).toBe(false);
    expect(isValidCollectionId('a'.repeat(256))).toBe(false);
  });
});
