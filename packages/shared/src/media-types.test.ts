import { describe, expect, it } from 'vitest';
import { fileExtension, UPLOAD_EXTENSIONS, UPLOAD_MIME_TYPES, uploadFileType } from './media-types';

describe('upload allowlist', () => {
  it('lists JPEG, PNG, WebP, MP4 and MOV', () => {
    expect(UPLOAD_MIME_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/quicktime',
    ]);
    expect(UPLOAD_EXTENSIONS).toEqual(['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov']);
  });

  it.each([
    ['IMG_0001.JPG', 'image/jpeg', 'image'],
    ['a.jpeg', 'image/jpeg', 'image'],
    ['a.png', 'IMAGE/PNG', 'image'],
    ['a.webp', 'image/webp', 'image'],
    ['clip.MP4', 'video/mp4', 'video'],
    ['clip.mov', 'video/quicktime; codecs="hvc1"', 'video'],
    ['งานวิ่ง 2026.jpg', 'image/jpeg', 'image'],
  ])('accepts %s declared as %s', (name, mime, kind) => {
    expect(uploadFileType(name, mime)?.kind).toBe(kind);
  });

  it.each([
    ['a.heic', 'image/heic'],
    ['a.cr3', 'image/x-canon-cr3'],
    ['a.jpg', 'image/png'],
    ['a.png', 'image/jpeg'],
    ['a.mov', 'video/mp4'],
    ['a.gif', 'image/gif'],
    ['a.jpg', ''],
    ['jpg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['a.', 'image/jpeg'],
    ['a.jpg.exe', 'image/jpeg'],
  ])('rejects %s declared as %s', (name, mime) => {
    expect(uploadFileType(name, mime)).toBeNull();
  });

  it('extracts lowercase extensions', () => {
    expect(fileExtension('a.b.JPG')).toBe('jpg');
    expect(fileExtension('noext')).toBeNull();
    expect(fileExtension('.hidden')).toBeNull();
    expect(fileExtension('a.j p g')).toBeNull();
  });
});
