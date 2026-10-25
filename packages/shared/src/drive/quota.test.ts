import { describe, expect, it } from 'vitest';
import {
  availableBytes,
  canReserve,
  commitReservation,
  expectedUsage,
  fileQuotaBucket,
  releaseReservation,
  releaseUsed,
  reserveQuota,
  subscriptionAllowsUploads,
  uploadsBlockedBy,
} from './quota';

const GiB = 1024 ** 3;
const state = { usedBytes: 6 * GiB, reservedBytes: 2 * GiB, quotaBytes: 10 * GiB };

describe('quota reservation', () => {
  it('allows used + reserved + size <= quota, exactly at the limit too', () => {
    expect(canReserve(state, 2 * GiB)).toBe(true);
    expect(canReserve(state, 2 * GiB + 1)).toBe(false);
    expect(availableBytes(state)).toBe(2 * GiB);
  });

  it('reserves, or explains QUOTA_EXCEEDED', () => {
    expect(reserveQuota(state, GiB)).toEqual({
      ok: true,
      usage: { usedBytes: 6 * GiB, reservedBytes: 3 * GiB },
    });
    expect(reserveQuota(state, 3 * GiB)).toEqual({
      ok: false,
      code: 'QUOTA_EXCEEDED',
      details: {
        quotaBytes: 10 * GiB,
        usedBytes: 6 * GiB,
        reservedBytes: 2 * GiB,
        requestedBytes: 3 * GiB,
        availableBytes: 2 * GiB,
      },
    });
  });

  it('reports 0 available after a downgrade below current usage', () => {
    const over = { usedBytes: 60 * GiB, reservedBytes: 0, quotaBytes: 50 * GiB };
    expect(availableBytes(over)).toBe(0);
    expect(canReserve(over, 1)).toBe(false);
  });

  it('commits and releases without going negative', () => {
    const usage = { usedBytes: 10, reservedBytes: 5 };
    expect(commitReservation(usage, 5)).toEqual({ usedBytes: 15, reservedBytes: 0 });
    expect(releaseReservation(usage, 5)).toEqual({ usedBytes: 10, reservedBytes: 0 });
    expect(releaseUsed(usage, 10)).toEqual({ usedBytes: 0, reservedBytes: 5 });
    expect(() => commitReservation(usage, 6)).toThrow(RangeError);
    expect(() => releaseReservation(usage, 6)).toThrow(RangeError);
    expect(() => releaseUsed(usage, 11)).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])('rejects byte count %s', (bad) => {
    expect(() => canReserve(state, bad)).toThrow(RangeError);
    expect(() => availableBytes({ ...state, usedBytes: bad })).toThrow(RangeError);
  });
});

describe('fileQuotaBucket', () => {
  const file = { status: 'uploading' as const, verifiedAt: null, purgeRequestedAt: null };

  it('puts each file in one bucket', () => {
    expect(fileQuotaBucket(file)).toBe('reserved');
    expect(fileQuotaBucket({ ...file, status: 'processing' })).toBe('reserved');
    expect(fileQuotaBucket({ ...file, status: 'processing', verifiedAt: new Date() })).toBe('used');
    expect(fileQuotaBucket({ ...file, status: 'ready', verifiedAt: '2026-10-25T00:00:00Z' })).toBe(
      'used',
    );
    expect(fileQuotaBucket({ ...file, status: 'failed' })).toBe('none');
    expect(
      fileQuotaBucket({
        ...file,
        status: 'ready',
        verifiedAt: new Date(),
        purgeRequestedAt: new Date(),
      }),
    ).toBe('none');
  });

  it('sums the expected counters for reconciliation (trash included until purge)', () => {
    expect(
      expectedUsage([
        { ...file, sizeBytes: 1 },
        { ...file, status: 'ready', verifiedAt: new Date(), sizeBytes: 10 },
        { ...file, status: 'failed', sizeBytes: 100 },
        {
          ...file,
          status: 'ready',
          verifiedAt: new Date(),
          purgeRequestedAt: new Date(),
          sizeBytes: 1000,
        },
      ]),
    ).toEqual({ usedBytes: 10, reservedBytes: 1 });
  });
});

describe('subscriptions and uploads', () => {
  it('allows uploads in trial and active only', () => {
    expect(subscriptionAllowsUploads('trial')).toBe(true);
    expect(subscriptionAllowsUploads('active')).toBe(true);
    for (const status of ['grace', 'expired', 'purged'] as const) {
      expect(subscriptionAllowsUploads(status)).toBe(false);
    }
    expect(subscriptionAllowsUploads(null)).toBe(false);
  });

  it('names what blocks uploads, the subscription first', () => {
    const full = { usedBytes: 10, reservedBytes: 0, quotaBytes: 10 };
    expect(uploadsBlockedBy('active', state)).toBeNull();
    expect(uploadsBlockedBy('active', full)).toBe('QUOTA_EXCEEDED');
    expect(uploadsBlockedBy('grace', full)).toBe('SUBSCRIPTION_INACTIVE');
    expect(uploadsBlockedBy(null, state)).toBe('SUBSCRIPTION_INACTIVE');
  });
});
