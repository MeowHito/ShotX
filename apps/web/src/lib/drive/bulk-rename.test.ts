import { describe, expect, it } from 'vitest';
import { nameStem, numberedNames, renameSteps } from './bulk-rename';

const f = (id: string, name: string, folderId: string | null = 'ev') => ({ id, name, folderId });

describe('bulk rename (ADR 0023)', () => {
  it('numbers several files in the order given, each keeping its extension', () => {
    expect(
      numberedNames('  A ', [f('1', 'x.JPG'), f('2', 'y.png'), f('3', 'noext')])?.map((r) => r.to),
    ).toEqual(['A(1).JPG', 'A(2).png', 'A(3)']);
    // One file: no number.
    expect(numberedNames('ปก', [f('1', 'IMG_0001.jpg')])?.map((r) => r.to)).toEqual(['ปก.jpg']);
  });

  it('refuses names the drive refuses', () => {
    expect(numberedNames('', [f('1', 'a.jpg')])).toBeNull();
    expect(numberedNames('a/b', [f('1', 'a.jpg')])).toBeNull();
    expect(numberedNames('x'.repeat(300), [f('1', 'a.jpg')])).toBeNull();
  });

  it('skips files already named right and steps aside when the batch swaps names', () => {
    // Renaming A(1), A(2) again in the other order: both first move to temporary names.
    const planned = numberedNames('A', [f('2', 'A(2).jpg'), f('1', 'A(1).jpg')]) ?? [];
    const steps = renameSteps(planned, (r, n) => `tmp${n}.jpg`);
    expect(steps).toEqual([
      { id: '2', name: 'tmp0.jpg', final: false },
      { id: '1', name: 'tmp1.jpg', final: false },
      { id: '2', name: 'A(1).jpg', final: true },
      { id: '1', name: 'A(2).jpg', final: true },
    ]);
    // Already right: nothing to send.
    expect(renameSteps(numberedNames('A', [f('1', 'A(1).jpg'), f('2', 'A(2).jpg')]) ?? [])).toEqual(
      [],
    );
    // The same name in another folder doesn't clash.
    const apart = numberedNames('A', [f('1', 'b.jpg', 'one'), f('2', 'A(1).jpg', 'two')]) ?? [];
    expect(renameSteps(apart).every((s) => s.final)).toBe(true);
  });

  it('takes the stem of a name', () => {
    expect(nameStem('IMG_0001.jpg')).toBe('IMG_0001');
    expect(nameStem('archive.tar.gz')).toBe('archive.tar');
    expect(nameStem('README')).toBe('README');
  });
});
