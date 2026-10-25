import {
  type FaceProvider,
  REKOGNITION_DELETE_FACES_BATCH,
  REKOGNITION_LIST_FACES_MAX_RESULTS,
} from './provider';
import { type Clock, systemClock } from './throttling';
import type { ListedFace } from './types';

/**
 * Orphan reconciliation: deleting faces that are in a collection but have no `faces` row.
 *
 * Purges and face-index expiry delete the face ids they find in `faces` rows, so a face without a
 * row would never expire. Faces end up without a row when cleanup after a failed indexing attempt
 * fails too (IndexPhotoError.orphanFaceIds), when IndexFaces fails after indexing faces it never
 * returned (IndexPhotoError.untrackedFacesPossible), or when a worker dies between IndexFaces and
 * its database insert. The last two leave ids nobody knows, so only listing the collection finds
 * them.
 *
 * In-flight indexing: a face that an attempt has indexed but not yet recorded looks exactly like
 * an orphan. A face is therefore deleted only when the database didn't know it when the listing
 * finished and still doesn't know it at least `graceMs` later. That is safe because the worker
 * follows one rule: an attempt commits its rows before `recordFacesDeadline(startedAtMs, graceMs)`,
 * measured from before it calls `indexPhoto`, or never (it deletes its faces itself, or leaves
 * them to reconciliation). Every listed face was indexed before the listing finished, so by the
 * time the grace period has passed its attempt has either committed (the face is kept) or will
 * never commit (the face is an orphan).
 *
 * Everything is safe to rerun: deleting a face that is already gone is a no-op.
 */

/**
 * Which of `faceIds` have a row in `faces`. Read from the primary database: a lagging replica
 * makes recorded faces look orphaned.
 */
export type KnownFaceIds = (faceIds: readonly string[]) => Promise<Iterable<string>>;

/** Share of the grace period an indexing attempt may take before it commits its rows. */
const RECORD_SHARE_OF_GRACE = 0.5;

/**
 * The last moment (ms, same clock as `startedAtMs`) at which an indexing attempt that started at
 * `startedAtMs` may still commit its `faces` rows. Half the grace period: the other half covers
 * commit latency, replica lag and clock differences between hosts. Check it inside the
 * transaction, right before the commit.
 */
export function recordFacesDeadline(startedAtMs: number, graceMs: number): number {
  return startedAtMs + graceMs * RECORD_SHARE_OF_GRACE;
}

/** Every face in a collection, one ListFaces page at a time. */
export async function* listCollectionFaces(
  provider: FaceProvider,
  collectionId: string,
  pageSize: number = REKOGNITION_LIST_FACES_MAX_RESULTS,
): AsyncGenerator<ListedFace[]> {
  let nextToken: string | undefined;
  do {
    const page = await provider.listFaces({ collectionId, maxResults: pageSize, nextToken });
    if (page.nextToken !== undefined && page.nextToken === nextToken) {
      throw new Error(`ListFaces returned the same NextToken twice for ${collectionId}`);
    }
    nextToken = page.nextToken;
    yield page.faces;
  } while (nextToken !== undefined);
}

export interface ScanOptions {
  collectionId: string;
  knownFaceIds: KnownFaceIds;
  /** ListFaces page size; defaults to the API maximum. */
  pageSize?: number | undefined;
  clock?: Clock | undefined;
}

/** Faces a scan found without a row. Serializable, so the deletion can run in a later job. */
export interface OrphanScan {
  collectionId: string;
  /** When the listing finished (clock ms). Every face it found was indexed before then. */
  listedAtMs: number;
  /** Faces listed; a face that two pages both returned counts twice. */
  listed: number;
  listCalls: number;
  /** Listed faces the database did not know. Not yet safe to delete: see `deleteOrphans`. */
  candidateFaceIds: string[];
}

/** Lists the collection and asks the database, page by page, which faces it knows. */
export async function scanCollection(
  provider: FaceProvider,
  options: ScanOptions,
): Promise<OrphanScan> {
  const clock = options.clock ?? systemClock;
  const candidates = new Set<string>();
  let listed = 0;
  let listCalls = 0;
  for await (const faces of listCollectionFaces(provider, options.collectionId, options.pageSize)) {
    listCalls++;
    listed += faces.length;
    if (faces.length === 0) continue;
    const known = new Set(await options.knownFaceIds(faces.map((face) => face.faceId)));
    for (const face of faces) if (!known.has(face.faceId)) candidates.add(face.faceId);
  }
  return {
    collectionId: options.collectionId,
    listedAtMs: clock.now(),
    listed,
    listCalls,
    candidateFaceIds: [...candidates],
  };
}

export interface DeleteOrphansOptions {
  knownFaceIds: KnownFaceIds;
  /** How long after the scan a candidate must still be unknown before it is deleted. */
  graceMs: number;
  clock?: Clock | undefined;
}

export interface OrphanDeletion {
  /** Candidates the database knew by the time they were checked again: in-flight indexing. */
  claimed: number;
  deleted: number;
  deleteCalls: number;
}

/** Deleting orphans failed. The counts say how far it got; rerunning is safe. */
export class OrphanCleanupError extends Error {
  constructor(
    readonly collectionId: string,
    /** The orphans of the batch that failed. Later candidates were not checked yet. */
    readonly orphanFaceIds: readonly string[],
    readonly progress: OrphanDeletion,
    cause: unknown,
  ) {
    super(`Deleting ${orphanFaceIds.length} orphaned faces from ${collectionId} failed`, {
      cause,
    });
    this.name = 'OrphanCleanupError';
  }
}

/**
 * Deletes the scan's candidates that the database still doesn't know, in DeleteFaces batches
 * (each takes a DeleteFaces token from the provider's rate limiter). Each batch is checked again
 * right before it is deleted. Refuses to run before the grace period after the scan is over.
 */
export async function deleteOrphans(
  provider: FaceProvider,
  scan: OrphanScan,
  options: DeleteOrphansOptions,
): Promise<OrphanDeletion> {
  const clock = options.clock ?? systemClock;
  assertGrace(options.graceMs);
  const remainingMs = scan.listedAtMs + options.graceMs - clock.now();
  if (remainingMs > 0) {
    throw new RangeError(
      `Orphans of ${scan.collectionId} can't be deleted for another ${Math.ceil(remainingMs)} ms`,
    );
  }
  const progress: OrphanDeletion = { claimed: 0, deleted: 0, deleteCalls: 0 };
  const ids = scan.candidateFaceIds;
  for (let start = 0; start < ids.length; start += REKOGNITION_DELETE_FACES_BATCH) {
    const batch = ids.slice(start, start + REKOGNITION_DELETE_FACES_BATCH);
    const known = new Set(await options.knownFaceIds(batch));
    const orphans = batch.filter((faceId) => !known.has(faceId));
    progress.claimed += batch.length - orphans.length;
    if (orphans.length === 0) continue;
    try {
      await provider.deleteFaces(scan.collectionId, orphans);
    } catch (error) {
      throw new OrphanCleanupError(scan.collectionId, orphans, { ...progress }, error);
    }
    progress.deleteCalls++;
    progress.deleted += orphans.length;
  }
  return progress;
}

export interface ReconcileOptions extends ScanOptions {
  /**
   * How long a face must stay unknown before it is deleted. Longer than any indexing attempt may
   * take to record its faces: see `recordFacesDeadline`.
   */
  graceMs: number;
}

export interface ReconcileResult extends OrphanDeletion {
  collectionId: string;
  listed: number;
  listCalls: number;
  /** Faces the database did not know when the listing finished. */
  candidates: number;
}

/**
 * Finds and deletes the collection's orphans: scans, waits until the grace period after the scan
 * is over (only when there are candidates), then deletes the candidates that are still unknown.
 * A worker that would rather not wait can store the scan and call `deleteOrphans` in a later job.
 */
export async function reconcileCollection(
  provider: FaceProvider,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const clock = options.clock ?? systemClock;
  assertGrace(options.graceMs);
  const scan = await scanCollection(provider, options);
  let deletion: OrphanDeletion = { claimed: 0, deleted: 0, deleteCalls: 0 };
  if (scan.candidateFaceIds.length > 0) {
    // A loop, because timers may fire a little early.
    for (;;) {
      const waitMs = Math.ceil(scan.listedAtMs + options.graceMs - clock.now());
      if (waitMs <= 0) break;
      await clock.sleep(waitMs);
    }
    deletion = await deleteOrphans(provider, scan, options);
  }
  return {
    collectionId: scan.collectionId,
    listed: scan.listed,
    listCalls: scan.listCalls,
    candidates: scan.candidateFaceIds.length,
    ...deletion,
  };
}

function assertGrace(graceMs: number): void {
  if (!(graceMs >= 0 && Number.isFinite(graceMs))) {
    throw new RangeError(`Invalid orphan grace period: ${graceMs} ms`);
  }
}
