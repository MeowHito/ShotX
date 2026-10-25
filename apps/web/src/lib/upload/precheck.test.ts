import { ErrorCode } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import type { ApiError } from '../api/errors';
import { ClientError, describeError } from '../errors/messages';
import { filesFromDataTransfer, filesFromInput, relativeDir } from './dropped-files';
import { declaredMime, precheckFile, UPLOAD_ACCEPT } from './precheck';

const MAX = { image: 100 * 1024 * 1024, video: 5 * 1024 ** 3 };

describe('precheckFile', () => {
  it('accepts allowlisted files and infers a missing MIME type', () => {
    expect(precheckFile({ name: 'a.JPG', size: 10, type: 'image/jpeg' }, MAX)).toEqual({
      ok: true,
      mime: 'image/jpeg',
    });
    expect(precheckFile({ name: 'clip.mov', size: 10, type: '' }, MAX)).toEqual({
      ok: true,
      mime: 'video/quicktime',
    });
    expect(declaredMime({ name: 'x.unknown', type: '' })).toBe('application/octet-stream');
  });

  it('rejects HEIC and RAW with their hints', () => {
    const heic = precheckFile({ name: 'IMG_1.HEIC', size: 10, type: 'image/heic' }, MAX);
    expect(heic.ok).toBe(false);
    if (!heic.ok) expect(describeError(heic.error)).toEqual({ key: 'hints.heic' });
    const raw = precheckFile({ name: 'DSC_1.NEF', size: 10, type: '' }, MAX);
    if (!raw.ok) expect(describeError(raw.error)).toEqual({ key: 'hints.raw' });
    expect(raw.ok).toBe(false);
  });

  it('rejects other types, oversized and empty files', () => {
    const gif = precheckFile({ name: 'a.gif', size: 10, type: 'image/gif' }, MAX);
    expect(gif.ok || (gif.error as ApiError).code).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
    const big = precheckFile({ name: 'a.jpg', size: MAX.image + 1, type: 'image/jpeg' }, MAX);
    expect(big.ok ? null : big.error).toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
      details: { maxBytes: MAX.image },
    });
    const empty = precheckFile({ name: 'a.jpg', size: 0, type: 'image/jpeg' }, MAX);
    expect(empty.ok ? null : empty.error).toEqual(new ClientError('client.emptyFile'));
  });

  it('rejects relative paths with invalid folder names', () => {
    const result = precheckFile({ name: 'a.jpg', size: 1, type: 'image/jpeg' }, MAX, 'Event/..');
    expect(result.ok ? null : describeError(result.error).key).toBe('client.invalidRelativePath');
  });

  it('lists every allowlisted type in the accept attribute', () => {
    expect(UPLOAD_ACCEPT).toContain('image/jpeg');
    expect(UPLOAD_ACCEPT).toContain('.mov');
    expect(UPLOAD_ACCEPT).not.toContain('heic');
  });
});

describe('dropped files', () => {
  it('keeps folder paths from a folder picker', () => {
    expect(relativeDir('Event/Day 1/IMG_1.jpg')).toBe('Event/Day 1');
    expect(relativeDir('IMG_1.jpg')).toBeNull();
    const file = new File(['x'], 'IMG_1.jpg');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Event/IMG_1.jpg' });
    expect(filesFromInput([file])).toEqual([{ file, relativePath: 'Event' }]);
  });

  it('walks dropped folders, reading directories in batches and skipping hidden files', async () => {
    const fileEntry = (name: string) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (ok: (f: File) => void) => ok(new File(['x'], name)),
    });
    const dirEntry = (name: string, children: unknown[]) => {
      // readEntries returns one entry per call, then an empty batch.
      return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => {
          let i = 0;
          return {
            readEntries: (ok: (entries: unknown[]) => void) =>
              ok(i < children.length ? [children[i++]] : []),
          };
        },
      };
    };
    const tree = dirEntry('Event', [
      fileEntry('a.jpg'),
      fileEntry('.DS_Store'),
      dirEntry('Day 1', [fileEntry('b.jpg'), fileEntry('c.mp4')]),
    ]);
    const loose = new File(['x'], 'loose.png');
    const dataTransfer = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => tree, getAsFile: () => null },
        { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => loose },
      ],
      files: [],
    } as unknown as DataTransfer;

    const files = await filesFromDataTransfer(dataTransfer);
    expect(files.map((f) => [f.relativePath, f.file.name])).toEqual([
      ['Event', 'a.jpg'],
      ['Event/Day 1', 'b.jpg'],
      ['Event/Day 1', 'c.mp4'],
      [null, 'loose.png'],
    ]);
  });
});
