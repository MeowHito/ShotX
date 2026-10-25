import { describe, expect, it } from 'vitest';
import {
  checkUploadDeclaration,
  expectedPartSize,
  multipartPlan,
  partsMatchPlan,
  renameKeepsFileType,
  S3_MULTIPART_MAX_OBJECT_BYTES,
} from './upload';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe('multipartPlan', () => {
  it('uses the preferred part size when it fits in 10,000 parts', () => {
    expect(multipartPlan(100 * MiB, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 7 });
    expect(multipartPlan(5 * GiB, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 320 });
    expect(multipartPlan(16 * MiB, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 1 });
    expect(multipartPlan(1, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 1 });
    expect(multipartPlan(0, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 1 });
  });

  it('grows the part size to whole MiB when 10,000 parts would not be enough', () => {
    const plan = multipartPlan(200 * GiB, 16 * MiB);
    expect(plan.partSize % MiB).toBe(0);
    expect(plan.partSize).toBe(21 * MiB);
    expect(plan.partCount).toBeLessThanOrEqual(10_000);
    expect(plan.partSize * plan.partCount).toBeGreaterThanOrEqual(200 * GiB);
    expect(multipartPlan(S3_MULTIPART_MAX_OBJECT_BYTES, 5 * MiB)).toEqual({
      partSize: 5 * GiB,
      partCount: 10_000,
    });
  });

  it.each([
    [-1, 16 * MiB],
    [1.5, 16 * MiB],
    [S3_MULTIPART_MAX_OBJECT_BYTES + 1, 16 * MiB],
    [MiB, 5 * MiB - 1],
    [MiB, 5 * GiB + 1],
  ])('rejects size %s with part size %s', (size, part) => {
    expect(() => multipartPlan(size, part)).toThrow(RangeError);
  });

  it('gives the expected size of each part and checks ListParts against it', () => {
    const size = 40 * MiB + 3;
    const plan = multipartPlan(size, 16 * MiB);
    expect(plan.partCount).toBe(3);
    expect([1, 2, 3].map((n) => expectedPartSize(plan, size, n))).toEqual([
      16 * MiB,
      16 * MiB,
      8 * MiB + 3,
    ]);
    expect(() => expectedPartSize(plan, size, 4)).toThrow(RangeError);
    const parts = [
      { partNumber: 3, size: 8 * MiB + 3 },
      { partNumber: 1, size: 16 * MiB },
      { partNumber: 2, size: 16 * MiB },
    ];
    expect(partsMatchPlan(plan, size, parts)).toBe(true);
    expect(partsMatchPlan(plan, size, parts.slice(1))).toBe(false);
    // A bigger last part would make the object bigger than the reservation.
    expect(partsMatchPlan(plan, size, [...parts.slice(1), { partNumber: 3, size: 16 * MiB }])).toBe(
      false,
    );
  });
});

describe('checkUploadDeclaration', () => {
  const maxBytes = { image: 100 * MiB, video: 5 * GiB };

  it('accepts allowlisted pairs within the size limit', () => {
    const result = checkUploadDeclaration(
      { name: 'IMG.JPG', mime: 'image/jpeg', sizeBytes: MiB },
      maxBytes,
    );
    expect(result).toMatchObject({ ok: true, fileType: { kind: 'image', mime: 'image/jpeg' } });
    expect(
      checkUploadDeclaration(
        { name: 'a.mov', mime: 'video/quicktime', sizeBytes: 5 * GiB },
        maxBytes,
      ).ok,
    ).toBe(true);
  });

  it('rejects types with a hint for HEIC and RAW', () => {
    expect(
      checkUploadDeclaration({ name: 'a.HEIC', mime: 'image/heic', sizeBytes: 1 }, maxBytes),
    ).toEqual({
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      details: { extension: 'heic', hint: 'heic' },
    });
    expect(
      checkUploadDeclaration(
        { name: 'a.CR3', mime: 'application/octet-stream', sizeBytes: 1 },
        maxBytes,
      ),
    ).toMatchObject({ ok: false, details: { extension: 'cr3', hint: 'raw' } });
    expect(
      checkUploadDeclaration({ name: 'a.jpg', mime: 'image/png', sizeBytes: 1 }, maxBytes),
    ).toMatchObject({
      ok: false,
      details: { extension: 'jpg', hint: null },
    });
    expect(
      checkUploadDeclaration({ name: 'noext', mime: 'image/jpeg', sizeBytes: 1 }, maxBytes),
    ).toMatchObject({
      ok: false,
      details: { extension: null, hint: null },
    });
  });

  it('applies the limit of the media kind', () => {
    expect(
      checkUploadDeclaration(
        { name: 'a.png', mime: 'image/png', sizeBytes: 100 * MiB + 1 },
        maxBytes,
      ),
    ).toEqual({ ok: false, code: 'FILE_TOO_LARGE', details: { maxBytes: 100 * MiB } });
  });
});

describe('renameKeepsFileType', () => {
  it('keeps an extension of the same allowlist entry', () => {
    expect(renameKeepsFileType('image/jpeg', 'new.jpeg')).toBe(true);
    expect(renameKeepsFileType('image/jpeg', 'new.png')).toBe(false);
    expect(renameKeepsFileType('image/jpeg', 'new')).toBe(false);
    expect(renameKeepsFileType('video/mp4', 'งานวิ่ง.MP4')).toBe(true);
  });
});
