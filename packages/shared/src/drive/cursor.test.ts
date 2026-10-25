import { describe, expect, it } from 'vitest';
import { decodeDriveCursor, type DriveCursor, encodeDriveCursor } from './cursor';

const cursor: DriveCursor = {
  v: 1,
  sort: 'name',
  order: 'asc',
  phase: 'folders',
  key: 'งานวิ่ง 2026 + img_0001.jpg',
  kind: 'folder',
  id: '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b',
};

describe('drive cursors', () => {
  it('round-trips as URL-safe text', () => {
    const text = encodeDriveCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDriveCursor(text)).toEqual(cursor);
    expect(decodeDriveCursor(encodeDriveCursor({ ...cursor, key: null }))).toEqual({
      ...cursor,
      key: null,
    });
  });

  it('returns null for anything it did not make', () => {
    const forged = btoa(JSON.stringify({ ...cursor, key: 'a', v: 2 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    for (const text of ['', 'not a cursor!', 'AAAA', forged, 'x'.repeat(3000)]) {
      expect(decodeDriveCursor(text)).toBeNull();
    }
  });

  it('refuses to encode an invalid cursor', () => {
    expect(() => encodeDriveCursor({ ...cursor, id: 'nope' })).toThrow();
  });
});
