import { loadShareConfig, loadWorkerSettings } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
// Delete this file together with infra/ (ADR 0008): it only keeps the two copies of ADR 0006's
// checks equal while both exist.
import * as infra from '../../infra/lib/worker-limits';
import { TMP_RECONCILE_PREFIX as INFRA_TMP_RECONCILE_PREFIX } from '../../infra/lib/constants';
import * as deploy from '../r2/rules';

describe('ADR 0006 checks match infra/ while it exists', () => {
  it('computes the same zip lifetime and minimum days', () => {
    for (const env of [
      {},
      { ZIP_RESULT_TTL_SECONDS: String(2 * 86_400) },
      { WORKER_ZIP_MAX_PROCESSING_SECONDS: '600', SIGNED_URL_DOWNLOAD_TTL_SECONDS: '900' },
    ]) {
      const worker = loadWorkerSettings(env);
      const shares = [loadShareConfig(env)];
      const a = infra.zipObjectLifetime(worker, shares);
      const b = deploy.zipObjectLifetime(worker, shares);
      expect(b).toEqual(a);
      expect(deploy.minZipExpirationDays(b)).toBe(infra.minZipExpirationDays(a));
    }
  });

  it('computes the same reconcile minimum and prefix', () => {
    for (const grace of [0, 3 * 3_600_000, 86_400_000]) {
      expect(deploy.minReconcileExpirationDays(grace)).toBe(
        infra.minReconcileExpirationDays(grace),
      );
    }
    expect(deploy.TMP_RECONCILE_PREFIX).toBe(INFRA_TMP_RECONCILE_PREFIX);
  });
});
