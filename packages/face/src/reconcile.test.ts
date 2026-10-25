import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type FaceProvider,
  type ListFacesRequest,
  REKOGNITION_DELETE_FACES_BATCH,
} from './provider';
import {
  deleteOrphans,
  type KnownFaceIds,
  listCollectionFaces,
  OrphanCleanupError,
  reconcileCollection,
  recordFacesDeadline,
  scanCollection,
} from './reconcile';
import { FakeFaceProvider, renderScene, SyntheticWorld } from './testing';
import type { Clock } from './throttling';

const COLLECTION = 'pg-reconcile';
const GRACE_MS = 60_000;
const world = SyntheticWorld.create({ volunteers: 6, bystanders: 0, seed: 5 });
const persons = world.persons.map((person) => person.id);

/** One photo per volunteer, each with two faces. */
let photos: Buffer[];
beforeAll(async () => {
  photos = await Promise.all(
    persons.map((personId, i) =>
      renderScene(
        world,
        {
          width: 800,
          height: 600,
          faces: [
            { personId, pose: 'front', left: 100, top: 100, size: 200 },
            {
              personId: persons[(i + 1) % persons.length]!,
              pose: 'left',
              left: 450,
              top: 200,
              size: 180,
            },
          ],
        },
        i + 1,
      ),
    ),
  );
});

function manualClock(onSleep?: () => void): Clock & { time: number; sleeps: number[] } {
  const clock = {
    time: 0,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
      onSleep?.();
      return Promise.resolve();
    },
  };
  return clock;
}

/** A collection with six files of two faces each, and a `faces` table that tracks some of them. */
async function setup() {
  const fake = new FakeFaceProvider(world);
  await fake.createCollection(COLLECTION);
  const facesOf: string[][] = [];
  for (const [i, bytes] of photos.entries()) {
    const result = await fake.indexFaces({
      collectionId: COLLECTION,
      image: { bytes },
      externalImageId: `file-${i}`,
      maxFaces: 100,
      qualityFilter: 'NONE',
    });
    facesOf.push(result.faces.map((face) => face.faceId));
  }
  const rows = new Set<string>();
  const record = (...files: number[]) => {
    for (const file of files) for (const id of facesOf[file]!) rows.add(id);
  };
  const knownFaceIds = vi.fn<KnownFaceIds>((ids) =>
    Promise.resolve(ids.filter((id) => rows.has(id))),
  );
  const stored = () =>
    fake
      .storedFaces(COLLECTION)
      .map((face) => face.faceId)
      .sort();
  return { fake, facesOf, rows, record, knownFaceIds, stored };
}

describe('reconcileCollection', () => {
  it('deletes the faces no row tracks, keeps the rest, and finds nothing on a rerun', async () => {
    const { fake, facesOf, rows, record, knownFaceIds, stored } = await setup();
    expect(facesOf.flat()).toHaveLength(12);
    record(0, 1, 2, 3);
    const clock = manualClock();
    const options = {
      collectionId: COLLECTION,
      knownFaceIds,
      graceMs: GRACE_MS,
      pageSize: 5,
      clock,
    };

    const result = await reconcileCollection(fake, options);
    expect(result).toEqual({
      collectionId: COLLECTION,
      listed: 12,
      listCalls: 3,
      candidates: 4,
      claimed: 0,
      deleted: 4,
      deleteCalls: 1,
    });
    expect(stored()).toEqual([...rows].sort());
    // It waited out the grace period before deleting.
    expect(clock.sleeps).toEqual([GRACE_MS]);

    const rerun = await reconcileCollection(fake, options);
    expect(rerun).toMatchObject({ listed: 8, candidates: 0, deleted: 0, deleteCalls: 0 });
    expect(clock.sleeps).toEqual([GRACE_MS]);
  });

  it('keeps faces that an in-flight indexing attempt records during the grace period', async () => {
    const { fake, facesOf, record, knownFaceIds, stored } = await setup();
    record(0, 1, 2, 3);
    // Files 4 and 5 are being indexed: file 4's attempt commits its rows in time, file 5's dies.
    const clock = manualClock(() => record(4));
    const result = await reconcileCollection(fake, {
      collectionId: COLLECTION,
      knownFaceIds,
      graceMs: GRACE_MS,
      clock,
    });
    expect(result).toMatchObject({ candidates: 4, claimed: 2, deleted: 2 });
    expect(stored()).toEqual(facesOf.slice(0, 5).flat().sort());
  });

  it('surfaces a failed deletion with its orphans, and a rerun finishes the job', async () => {
    const { fake, facesOf, record, knownFaceIds, stored } = await setup();
    record(0, 1, 2, 3);
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    fake.failNext('deleteFaces', throttled);
    const options = {
      collectionId: COLLECTION,
      knownFaceIds,
      graceMs: GRACE_MS,
      clock: manualClock(),
    };

    const error: unknown = await reconcileCollection(fake, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrphanCleanupError);
    const cleanup = error as OrphanCleanupError;
    expect(cleanup.cause).toBe(throttled);
    expect(cleanup.collectionId).toBe(COLLECTION);
    expect([...cleanup.orphanFaceIds].sort()).toEqual(facesOf.slice(4).flat().sort());
    expect(cleanup.progress).toEqual({ claimed: 0, deleted: 0, deleteCalls: 0 });
    expect(stored()).toHaveLength(12);

    await expect(reconcileCollection(fake, options)).resolves.toMatchObject({ deleted: 4 });
    expect(stored()).toEqual(facesOf.slice(0, 4).flat().sort());
  });

  it('lets ListFaces failures through and deletes nothing', async () => {
    const { fake, knownFaceIds } = await setup();
    const denied = Object.assign(new Error('not allowed'), { name: 'AccessDeniedException' });
    fake.failNext('listFaces', denied, { after: 1 });
    await expect(
      reconcileCollection(fake, {
        collectionId: COLLECTION,
        knownFaceIds,
        graceMs: GRACE_MS,
        pageSize: 5,
        clock: manualClock(),
      }),
    ).rejects.toBe(denied);
    expect(fake.calls.deleteFaces).toBe(0);
  });

  it('does not wait when there is nothing to delete', async () => {
    const { fake, record, knownFaceIds } = await setup();
    record(0, 1, 2, 3, 4, 5);
    const clock = manualClock();
    await expect(
      reconcileCollection(fake, {
        collectionId: COLLECTION,
        knownFaceIds,
        graceMs: GRACE_MS,
        clock,
      }),
    ).resolves.toMatchObject({ listed: 12, candidates: 0 });
    expect(clock.sleeps).toEqual([]);
  });

  it('rejects a grace period that makes no sense', async () => {
    const { fake, knownFaceIds } = await setup();
    for (const graceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        reconcileCollection(fake, { collectionId: COLLECTION, knownFaceIds, graceMs }),
      ).rejects.toThrow(RangeError);
    }
    expect(fake.calls.listFaces).toBe(0);
  });
});

describe('scanCollection and deleteOrphans', () => {
  it('can run as two jobs, with the scan stored in between', async () => {
    const { fake, facesOf, record, knownFaceIds, stored } = await setup();
    record(0, 1, 2, 3);
    const clock = manualClock();
    const scan = await scanCollection(fake, { collectionId: COLLECTION, knownFaceIds, clock });
    expect(scan).toMatchObject({ listedAtMs: 0, listed: 12, listCalls: 1 });
    const stored1 = JSON.parse(JSON.stringify(scan)) as typeof scan;

    clock.time = GRACE_MS;
    await expect(
      deleteOrphans(fake, stored1, { knownFaceIds, graceMs: GRACE_MS, clock }),
    ).resolves.toEqual({
      claimed: 0,
      deleted: 4,
      deleteCalls: 1,
    });
    expect(stored()).toEqual(facesOf.slice(0, 4).flat().sort());
  });

  it('refuses to delete before the grace period after the scan is over', async () => {
    const { fake, knownFaceIds } = await setup();
    const clock = manualClock();
    clock.time = 1000;
    const scan = await scanCollection(fake, { collectionId: COLLECTION, knownFaceIds, clock });
    clock.time = 1000 + GRACE_MS - 1;
    await expect(
      deleteOrphans(fake, scan, { knownFaceIds, graceMs: GRACE_MS, clock }),
    ).rejects.toThrow(RangeError);
    expect(fake.calls.deleteFaces).toBe(0);
  });

  it('checks the database page by page and deletes in DeleteFaces batches', async () => {
    const ids = Array.from(
      { length: REKOGNITION_DELETE_FACES_BATCH + 904 },
      (_, i) => `face-${String(i).padStart(5, '0')}`,
    );
    const listFaces = vi.fn(({ nextToken, maxResults }: ListFacesRequest) => {
      const start = nextToken === undefined ? 0 : Number(nextToken);
      const end = start + maxResults;
      return Promise.resolve({
        faces: ids.slice(start, end).map((faceId) => ({ faceId })),
        nextToken: end < ids.length ? String(end) : undefined,
      });
    });
    const deleteFaces = vi.fn((_collectionId: string, _faceIds: readonly string[]) =>
      Promise.resolve(),
    );
    const provider = { listFaces, deleteFaces } as unknown as FaceProvider;
    const knownFaceIds = vi.fn<KnownFaceIds>((batch) =>
      Promise.resolve(batch.filter((id) => id.endsWith('7'))),
    );

    const result = await reconcileCollection(provider, {
      collectionId: COLLECTION,
      knownFaceIds,
      graceMs: GRACE_MS,
      clock: manualClock(),
    });
    const known = ids.filter((id) => id.endsWith('7')).length;
    expect(result).toEqual({
      collectionId: COLLECTION,
      listed: ids.length,
      listCalls: 2,
      candidates: ids.length - known,
      claimed: 0,
      deleted: ids.length - known,
      deleteCalls: 2,
    });
    expect(listFaces.mock.calls.map(([request]) => request.maxResults)).toEqual([4096, 4096]);
    // Two pages while listing, two batches checked again right before deleting.
    expect(knownFaceIds).toHaveBeenCalledTimes(4);
    expect(
      deleteFaces.mock.calls.every(([, batch]) => batch.length <= REKOGNITION_DELETE_FACES_BATCH),
    ).toBe(true);
  });
});

describe('listCollectionFaces', () => {
  it('stops when ListFaces repeats a NextToken instead of looping forever', async () => {
    const provider = {
      listFaces: () => Promise.resolve({ faces: [{ faceId: 'a' }], nextToken: 'same' }),
    } as unknown as FaceProvider;
    const pages: unknown[] = [];
    await expect(
      (async () => {
        for await (const page of listCollectionFaces(provider, COLLECTION)) pages.push(page);
      })(),
    ).rejects.toThrow(/same NextToken/);
    expect(pages).toHaveLength(1);
  });

  it('pages through the fake collection by face id', async () => {
    const { fake, facesOf } = await setup();
    const pages: string[][] = [];
    for await (const page of listCollectionFaces(fake, COLLECTION, 5)) {
      pages.push(page.map((face) => face.faceId));
    }
    expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
    expect(pages.flat()).toEqual(facesOf.flat().sort());
  });
});

describe('recordFacesDeadline', () => {
  it('leaves an indexing attempt half the grace period to record its faces', () => {
    expect(recordFacesDeadline(1_000, GRACE_MS)).toBe(1_000 + GRACE_MS / 2);
  });
});
