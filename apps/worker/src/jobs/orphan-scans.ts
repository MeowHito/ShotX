import type { OrphanScan } from '@shotx/face';
import { isSafeKeySegment, S3_PREFIXES } from '@shotx/shared';
import { z } from 'zod';
import type { ObjectStore } from '../aws/object-store';

/**
 * Where `faces.reconcile.daily` keeps each collection's OrphanScan between runs (two-job mode,
 * packages/face README rule 6).
 *
 * Interim storage: S3 JSON under `tmp/reconcile/{photographerId}.json` (infra: a 7-day lifecycle
 * rule on exactly this prefix, and Get/Put/Delete for the worker), well over the daily schedule's
 * 24 h. A lost scan only delays deletion by a day: the next run scans again. CONTRACT CHANGE REQUEST: a
 * `face_orphan_scans` table in packages/db (or, if S3 stays, a `reconcileScanKey` builder and a
 * `reconcile` kind in parseS3Key in packages/shared). Until then this is the worker's only
 * hand-built key; it uses the shared `tmp/` prefix and the shared segment rules.
 */
export interface OrphanScanStore {
  load(photographerId: string): Promise<OrphanScan | null>;
  save(photographerId: string, scan: OrphanScan): Promise<void>;
  remove(photographerId: string): Promise<void>;
}

export const RECONCILE_SCAN_PREFIX = `${S3_PREFIXES.tmp}reconcile/`;

/** `tmp/reconcile/{photographerId}.json` (see the CONTRACT CHANGE REQUEST above). */
export function reconcileScanKey(photographerId: string): string {
  if (!isSafeKeySegment(photographerId)) {
    throw new RangeError('Photographer id is not a safe key segment');
  }
  return `${RECONCILE_SCAN_PREFIX}${photographerId}.json`;
}

const orphanScanSchema = z.object({
  collectionId: z.string().min(1),
  listedAtMs: z.number().finite(),
  listed: z.number().int().nonnegative(),
  listCalls: z.number().int().nonnegative(),
  candidateFaceIds: z.array(z.string().min(1)),
});

export class S3OrphanScanStore implements OrphanScanStore {
  constructor(private readonly store: ObjectStore) {}

  async load(photographerId: string): Promise<OrphanScan | null> {
    const bytes = await this.store.get(reconcileScanKey(photographerId));
    if (bytes === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      return null; // unreadable: treated as missing, the run scans again
    }
    const parsed = orphanScanSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  save(photographerId: string, scan: OrphanScan): Promise<void> {
    return this.store.put(
      reconcileScanKey(photographerId),
      Buffer.from(JSON.stringify(scan), 'utf8'),
      'application/json',
    );
  }

  remove(photographerId: string): Promise<void> {
    return this.store.deleteObjects([reconcileScanKey(photographerId)]);
  }
}
