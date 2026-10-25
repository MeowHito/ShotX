import { DRIVE_ROUTES, ErrorCode, UPLOAD_ROUTES } from '@shotx/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeApi, type FakeApiOptions } from '../../../test/fake-api';
import { apiClientFor } from '../../../test/render';
import { ApiError } from '../api/errors';
import { ClientError } from '../errors/messages';
import { createDriveUploader, type DriveUploader, type DriveUploaderOptions } from './uploader';

const MiB = 1024 * 1024;
const PART = 5 * MiB;

let current: DriveUploader | null = null;
afterEach(() => {
  current?.destroy();
  current = null;
});

function setup(fakeOptions: FakeApiOptions = {}, options: Partial<DriveUploaderOptions> = {}) {
  const fake = new FakeApi({ partBytes: PART, initPresignedParts: 1, ...fakeOptions });
  const uploaded = vi.fn();
  const foldersCreated = vi.fn();
  const uploader = createDriveUploader({
    api: apiClientFor(fake.fetch),
    partBytes: PART,
    partConcurrency: 2,
    uploadPartBytes: fake.uploadPartBytes,
    retryDelays: [],
    autoProceed: false,
    onUploaded: uploaded,
    onFoldersCreated: foldersCreated,
    ...options,
  });
  current = uploader;
  return { fake, uploader, uppy: uploader.uppy, uploaded, foldersCreated };
}

function jpeg(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}

function add(
  uppy: DriveUploader['uppy'],
  file: File,
  meta: { folderId?: string | null; drivePath?: string | null } = {},
) {
  return uppy.addFile({
    name: file.name,
    type: file.type,
    data: file,
    meta: { folderId: meta.folderId ?? null, drivePath: meta.drivePath ?? null, mime: file.type },
  });
}

describe('drive uploader (Uppy + @uppy/aws-s3 multipart)', () => {
  it('runs init → sign parts → S3 PUTs → complete, with bytes only going to S3', async () => {
    const { fake, uppy, uploaded } = setup();
    add(uppy, jpeg('IMG_0001.jpg', 12 * MiB));
    const result = await uppy.upload();

    expect(result?.failed ?? []).toHaveLength(0);
    expect(fake.callsTo(UPLOAD_ROUTES.init)).toHaveLength(1);
    expect(fake.callsTo(UPLOAD_ROUTES.init)[0]?.body).toEqual({
      name: 'IMG_0001.jpg',
      size: 12 * MiB,
      mime: 'image/jpeg',
      folderId: null,
    });
    // Init presigned part 1; parts 2 and 3 were signed on demand.
    const signed = fake
      .callsTo(UPLOAD_ROUTES.signParts)
      .flatMap((c) => (c.body as { partNumbers: number[] }).partNumbers);
    expect(signed.sort()).toEqual([2, 3]);
    expect(fake.s3Puts.map((p) => [p.partNumber, p.size]).sort()).toEqual([
      [1, PART],
      [2, PART],
      [3, 2 * MiB],
    ]);
    const complete = fake.callsTo(UPLOAD_ROUTES.complete);
    expect(complete).toHaveLength(1);
    expect(complete[0]?.body).toEqual({
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
    expect(uploaded).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' }));
    // No API request carried file bytes.
    for (const call of fake.calls)
      expect(JSON.stringify(call.body ?? '').length).toBeLessThan(2000);
  });

  it('uploads parts in parallel up to the configured concurrency', async () => {
    const { fake, uppy } = setup({ initPresignedParts: 0 }, { partConcurrency: 3 });
    fake.s3DelayMs = 20;
    add(uppy, jpeg('big.jpg', 40 * MiB));
    await uppy.upload();
    expect(fake.s3Puts).toHaveLength(8);
    expect(fake.s3MaxInFlight).toBeGreaterThan(1);
    expect(fake.s3MaxInFlight).toBeLessThanOrEqual(3);
  });

  it('signs parts in batches instead of one request per part', async () => {
    const { fake, uppy } = setup({ initPresignedParts: 0 });
    add(uppy, jpeg('big.jpg', 40 * MiB));
    await uppy.upload();
    expect(fake.callsTo(UPLOAD_ROUTES.signParts).length).toBeLessThan(8);
  });

  it('sends relativePath for dropped folders and reports created folders', async () => {
    const { fake, uppy, foldersCreated } = setup();
    add(uppy, jpeg('a.jpg', 1000), { drivePath: 'Event/Day 1' });
    await uppy.upload();
    expect(fake.callsTo(UPLOAD_ROUTES.init)[0]?.body).toMatchObject({
      relativePath: 'Event/Day 1',
    });
    expect(foldersCreated).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Event', parentId: null }),
      expect.objectContaining({ name: 'Day 1' }),
    ]);
    const day1 = [...fake.folders.values()].find((f) => f.name === 'Day 1');
    expect([...fake.files.values()][0]?.folderId).toBe(day1?.id);
  });

  it('surfaces QUOTA_EXCEEDED with its details', async () => {
    const { fake, uppy, uploader } = setup({ quotaBytes: 10 * MiB, usedBytes: 9 * MiB });
    const id = add(uppy, jpeg('a.jpg', 2 * MiB));
    const result = await uppy.upload();
    expect(result?.failed).toHaveLength(1);
    const error = uploader.errorFor(id);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
      details: { requestedBytes: 2 * MiB, availableBytes: 1 * MiB },
    });
    expect(fake.s3Puts).toHaveLength(0);
  });

  it('aborts and fails the file when the server plans different parts', async () => {
    const { fake, uppy, uploader } = setup({ partSizeOverride: 8 * MiB });
    const id = add(uppy, jpeg('a.jpg', 12 * MiB));
    await uppy.upload();
    expect(uploader.errorFor(id)).toEqual(new ClientError('client.uploadPlanMismatch'));
    expect(fake.callsTo(UPLOAD_ROUTES.abort)).toHaveLength(1);
    expect(fake.uploads.size).toBe(0);
    expect(fake.s3Puts).toHaveLength(0);
  });

  it('aborts the upload (releasing the reservation) when the file is removed', async () => {
    const { fake, uppy } = setup();
    fake.holdPart = (_fileId, partNumber) => partNumber === 2;
    const id = add(uppy, jpeg('a.jpg', 12 * MiB));
    void uppy.upload();
    await vi.waitFor(() => expect(fake.s3Puts.length).toBeGreaterThan(0));
    uppy.removeFile(id);
    await vi.waitFor(() => expect(fake.callsTo(UPLOAD_ROUTES.abort)).toHaveLength(1));
    expect(fake.uploads.size).toBe(0);
    expect(fake.callsTo(UPLOAD_ROUTES.complete)).toHaveLength(0);
  });

  it('resumes after a pause with listParts and only uploads the missing parts', async () => {
    const { fake, uppy } = setup();
    let holding = true;
    fake.holdPart = (_fileId, partNumber) => holding && partNumber === 3;
    const id = add(uppy, jpeg('a.jpg', 12 * MiB));
    const done = new Promise((resolve) => uppy.on('complete', resolve));
    void uppy.upload();
    await vi.waitFor(() => expect(fake.s3Puts.map((p) => p.partNumber).sort()).toEqual([1, 2]));
    uppy.pauseResume(id);
    holding = false;
    uppy.pauseResume(id);
    await done;
    expect(fake.callsTo(UPLOAD_ROUTES.listParts).length).toBeGreaterThan(0);
    expect(fake.s3Puts.map((p) => p.partNumber).sort()).toEqual([1, 2, 3]);
    expect(fake.callsTo(UPLOAD_ROUTES.complete)).toHaveLength(1);
  });

  it('never calls drive routes while uploading', async () => {
    const { fake, uppy } = setup();
    add(uppy, jpeg('a.jpg', 1000));
    await uppy.upload();
    expect(fake.callsTo(DRIVE_ROUTES.listChildren)).toHaveLength(0);
  });
});
