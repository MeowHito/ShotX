import { describe, expect, it } from 'vitest';
import { folderPath, folderPathLabel } from './ltree';

const root = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const child = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';

describe('folder paths', () => {
  it('turns a folder id into a label', () => {
    expect(folderPathLabel(root)).toBe('0195f3a2_7c1e_7d4a_9b2f_3c4d5e6f7a8b');
  });

  it('builds root and child paths', () => {
    const rootPath = folderPath(null, root);
    expect(rootPath).toBe('0195f3a2_7c1e_7d4a_9b2f_3c4d5e6f7a8b');
    expect(folderPath(rootPath, child)).toBe(
      '0195f3a2_7c1e_7d4a_9b2f_3c4d5e6f7a8b.0195f3a2_8d2f_7e5b_8c3a_4d5e6f7a8b9c',
    );
  });

  it.each(['', 'a.b', 'a b', 'ก', 'x'.repeat(1001)])('rejects id %j', (id) => {
    expect(() => folderPathLabel(id)).toThrow(RangeError);
  });

  it.each(['', '.a', 'a.', 'a..b', 'a.b c', "a'; DROP TABLE folders; --"])(
    'rejects parent path %j',
    (path) => {
      expect(() => folderPath(path, child)).toThrow(RangeError);
    },
  );
});
