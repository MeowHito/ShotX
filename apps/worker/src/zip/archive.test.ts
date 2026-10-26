import { zipKey } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../testing/memory-aws';
import { streamZip, ZipJobFailure } from './archive';

const KiB = 1024;
const PHOTOGRAPHER = '0199b2a0-0000-7000-8000-000000000001';
const key = (i: number) =>
  `derived/${PHOTOGRAPHER}/0199b2a0-0000-7000-8000-00000000001${i}/web.jpg`;

function seeded(sizes: number[]): MemoryObjectStore {
  const store = new MemoryObjectStore();
  sizes.forEach((size, i) => store.seed(key(i), Buffer.alloc(size, i + 1)));
  return store;
}

const entries = (sizes: number[]) =>
  sizes.map((bytes, i) => ({
    fileId: `f${i}`,
    key: key(i),
    name: `IMG_${i}.jpg`,
    bytes,
    date: new Date(),
  }));

const options = (signal: AbortSignal, maxBytes = 10 * 1024 * KiB) => ({
  maxBytes,
  partBytes: 64 * KiB,
  signal,
});

describe('streamZip failure paths', () => {
  it('rejects with the caller reason and closes the source when the signal aborts mid-entry', async () => {
    const sizes = [512 * KiB, 512 * KiB];
    const store = seeded(sizes);
    store.streamChunkBytes = 16 * KiB;
    const abort = new AbortController();
    const getStream = store.getStream.bind(store);
    store.getStream = async (k, signal) => {
      const stream = await getStream(k, signal);
      // Abort while the entry is streaming: the fake destroys the source with ECONNRESET, like
      // the SDK. Vitest fails the run if that error is ever unhandled.
      stream.once('data', () => abort.abort(new Error('lost')));
      return stream;
    };
    await expect(
      streamZip(
        store,
        zipKey('0199b2a0-0000-7000-8000-0000000000aa'),
        entries(sizes),
        options(abort.signal),
      ),
    ).rejects.toThrow('lost');
    expect(store.calls.streamsOpened).toBe(1);
    expect(store.objects.has(zipKey('0199b2a0-0000-7000-8000-0000000000aa'))).toBe(false);
  });

  it('rejects with the upload error, not the archive AbortError', async () => {
    const sizes = [256 * KiB];
    const store = seeded(sizes);
    store.failUploads = true;
    await expect(
      streamZip(
        store,
        zipKey('0199b2a0-0000-7000-8000-0000000000bb'),
        entries(sizes),
        options(new AbortController().signal),
      ),
    ).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });

  it('rejects with ZipJobFailure at the byte limit', async () => {
    const sizes = [256 * KiB, 256 * KiB];
    const store = seeded(sizes);
    await expect(
      streamZip(
        store,
        zipKey('0199b2a0-0000-7000-8000-0000000000cc'),
        entries(sizes),
        options(new AbortController().signal, 300 * KiB),
      ),
    ).rejects.toBeInstanceOf(ZipJobFailure);
  });
});
