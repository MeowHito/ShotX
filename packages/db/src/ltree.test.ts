import { describe, expect, it } from 'vitest';
import {
  childFolderDepth,
  folderDepth,
  folderPath,
  folderPathLabel,
  isPathWithin,
  planFolderMove,
  rewriteFolderPath,
} from './ltree';

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

const grandchild = '0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9cad';
const other = '0195f3a2-af4b-7a7d-8e5c-6f7a8b9cadbe';

describe('folder moves', () => {
  const rootPath = folderPath(null, root);
  const childPath = folderPath(rootPath, child);
  const grandchildPath = folderPath(childPath, grandchild);
  const otherPath = folderPath(null, other);
  const childFolder = { id: child, path: childPath, parentId: root };

  it('measures depth and containment like nlevel and <@', () => {
    expect(folderDepth(rootPath)).toBe(1);
    expect(folderDepth(grandchildPath)).toBe(3);
    expect(childFolderDepth(null)).toBe(1);
    expect(childFolderDepth(childPath)).toBe(3);
    expect(isPathWithin(grandchildPath, rootPath)).toBe(true);
    expect(isPathWithin(rootPath, rootPath)).toBe(true);
    expect(isPathWithin(rootPath, grandchildPath)).toBe(false);
    // A label prefix is not an ancestor.
    expect(isPathWithin('abc', 'ab')).toBe(false);
  });

  it('plans a move to another parent and rewrites the subtree prefix', () => {
    const result = planFolderMove({
      folder: childFolder,
      newParent: { id: other, path: otherPath },
      subtreeMaxDepth: 3,
      maxDepth: 32,
    });
    expect(result).toEqual({
      ok: true,
      plan: {
        folderId: child,
        newParentId: other,
        oldPath: childPath,
        newPath: folderPath(otherPath, child),
        noop: false,
      },
    });
    if (!result.ok) return;
    expect(rewriteFolderPath(grandchildPath, result.plan)).toBe(
      folderPath(folderPath(otherPath, child), grandchild),
    );
    expect(rewriteFolderPath(childPath, result.plan)).toBe(result.plan.newPath);
    expect(() => rewriteFolderPath(otherPath, result.plan)).toThrow(RangeError);
  });

  it('plans a move to the root, and a no-op move', () => {
    const toRoot = planFolderMove({
      folder: childFolder,
      newParent: null,
      subtreeMaxDepth: 3,
      maxDepth: 32,
    });
    expect(toRoot).toMatchObject({
      ok: true,
      plan: { newParentId: null, newPath: folderPath(null, child) },
    });
    const same = planFolderMove({
      folder: childFolder,
      newParent: { id: root, path: rootPath },
      subtreeMaxDepth: 3,
      maxDepth: 32,
    });
    expect(same).toMatchObject({ ok: true, plan: { noop: true, newPath: childPath } });
  });

  it('rejects moving a folder into itself or its own descendant', () => {
    for (const newParent of [
      { id: child, path: childPath },
      { id: grandchild, path: grandchildPath },
    ]) {
      expect(
        planFolderMove({ folder: childFolder, newParent, subtreeMaxDepth: 3, maxDepth: 32 }),
      ).toEqual({
        ok: false,
        code: 'INVALID_MOVE',
      });
    }
  });

  it('rejects moves that make the subtree too deep', () => {
    // child's subtree is 2 levels deep (child, grandchild); under grandchild-depth parents it grows.
    const deepParent = {
      id: other,
      path: folderPath(folderPath(null, root.replace('7c1e', '7c1f')), other),
    };
    expect(
      planFolderMove({
        folder: childFolder,
        newParent: deepParent,
        subtreeMaxDepth: 3,
        maxDepth: 3,
      }),
    ).toEqual({ ok: false, code: 'FOLDER_DEPTH_EXCEEDED', maxDepth: 3 });
    expect(
      planFolderMove({
        folder: childFolder,
        newParent: deepParent,
        subtreeMaxDepth: 3,
        maxDepth: 4,
      }).ok,
    ).toBe(true);
  });

  it('refuses inputs that do not describe the folder', () => {
    expect(() =>
      planFolderMove({
        folder: { ...childFolder, path: otherPath },
        newParent: null,
        subtreeMaxDepth: 3,
        maxDepth: 32,
      }),
    ).toThrow(RangeError);
    expect(() =>
      planFolderMove({ folder: childFolder, newParent: null, subtreeMaxDepth: 1, maxDepth: 32 }),
    ).toThrow(RangeError);
  });
});
