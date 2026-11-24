import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../errors';
import { packageTotal, packageTotalSchema, vatOnTop } from './money';
import {
  addPackageDays,
  applyPackage,
  maskEmail,
  packageDaysLeft,
  packageExpired,
  packageUploadsBlockedBy,
  photosRemaining,
  type PhotographerPackageState,
} from './packages';

const DAY = 86_400_000;
const now = new Date('2026-11-16T03:00:00.000Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

describe('vatOnTop and packageTotal (ADR 0026)', () => {
  it('adds 7% VAT on top of the VAT-exclusive package prices', () => {
    expect(vatOnTop(39_900, 700)).toBe(2_793);
    expect(packageTotal(39_900, 700)).toEqual({
      priceSatang: 39_900,
      vatSatang: 2_793,
      totalSatang: 42_693,
      vatRateBasisPoints: 700,
    });
    expect(packageTotal(59_900, 700).totalSatang).toBe(64_093);
    expect(packageTotal(79_900, 700).totalSatang).toBe(85_493);
    expect(packageTotal(129_900, 700)).toEqual({
      priceSatang: 129_900,
      vatSatang: 9_093,
      totalSatang: 138_993,
      vatRateBasisPoints: 700,
    });
    expect(packageTotal(0, 700)).toEqual({
      priceSatang: 0,
      vatSatang: 0,
      totalSatang: 0,
      vatRateBasisPoints: 700,
    });
  });

  it('rounds half up, exactly', () => {
    // 50 × 7% = 3.5 → 4; 49 × 7% = 3.43 → 3; 150 × 1% = 1.5 → 2.
    expect(vatOnTop(50, 700)).toBe(4);
    expect(vatOnTop(49, 700)).toBe(3);
    expect(vatOnTop(150, 100)).toBe(2);
    expect(vatOnTop(12_345, 0)).toBe(0);
    expect(vatOnTop(12_345, 10_000)).toBe(12_345);
  });

  it('refuses amounts and rates that are not integers in range', () => {
    expect(() => vatOnTop(-1, 700)).toThrow(RangeError);
    expect(() => vatOnTop(1.5, 700)).toThrow(RangeError);
    expect(() => vatOnTop(100, 10_001)).toThrow(RangeError);
    expect(() => vatOnTop(100, 7.5)).toThrow(RangeError);
  });

  it('validates a breakdown whose total is price + vat', () => {
    expect(packageTotalSchema.safeParse(packageTotal(59_900, 700)).success).toBe(true);
    expect(
      packageTotalSchema.safeParse({
        priceSatang: 59_900,
        vatSatang: 4_193,
        totalSatang: 64_000,
        vatRateBasisPoints: 700,
      }).success,
    ).toBe(false);
  });
});

describe('package rules (ADR 0026 §2)', () => {
  const d7 = { id: 'pkg-d7', days: 7, photoLimit: 3_000 };
  const d3 = { id: 'pkg-d3', days: 3, photoLimit: 1_000 };
  const running: PhotographerPackageState = {
    packageId: 'pkg-free',
    startsAt: at(-DAY),
    expiresAt: at(2 * DAY),
    photoLimit: 100,
    photosUsed: 40,
  };

  it('starts a fresh period when there is no row', () => {
    expect(applyPackage(null, d7, now)).toEqual({
      kind: 'fresh',
      packageId: 'pkg-d7',
      startsAt: now,
      expiresAt: at(7 * DAY),
      photoLimit: 3_000,
      photosUsed: 0,
    });
  });

  it('starts a fresh period when the row has expired, also at the exact expiry instant', () => {
    const expired = { ...running, expiresAt: now, photosUsed: 100 };
    expect(applyPackage(expired, d3, now)).toEqual({
      kind: 'fresh',
      packageId: 'pkg-d3',
      startsAt: now,
      expiresAt: at(3 * DAY),
      photoLimit: 1_000,
      photosUsed: 0,
    });
    expect(applyPackage({ ...running, expiresAt: at(-1) }, d3, now).kind).toBe('fresh');
  });

  it('extends a running package: more days from its expiry and more photos, usage kept', () => {
    expect(applyPackage(running, d7, now)).toEqual({
      kind: 'extend',
      packageId: 'pkg-d7',
      startsAt: running.startsAt,
      expiresAt: at(9 * DAY),
      photoLimit: 3_100,
      photosUsed: 40,
    });
    expect(applyPackage({ ...running, expiresAt: at(1) }, d3, now).kind).toBe('extend');
  });

  // ADR 0032: add-ons.
  const day1 = { id: 'pkg-day1', kind: 'days' as const, days: 1, photoLimit: 0 };
  const photo1000 = { id: 'pkg-photo1000', kind: 'photos' as const, days: 0, photoLimit: 1_000 };

  it('adds days to a running package and keeps the plan and its photos', () => {
    expect(applyPackage(running, day1, now)).toEqual({
      kind: 'add_days',
      packageId: 'pkg-free',
      startsAt: running.startsAt,
      expiresAt: at(3 * DAY),
      photoLimit: 100,
      photosUsed: 40,
    });
  });

  it('re-opens an expired package from now with days, photos and usage kept', () => {
    const expired = { ...running, expiresAt: at(-5 * DAY), photosUsed: 90 };
    expect(applyPackage(expired, day1, now)).toEqual({
      kind: 'add_days',
      packageId: 'pkg-free',
      startsAt: now,
      expiresAt: at(DAY),
      photoLimit: 100,
      photosUsed: 90,
    });
  });

  it('adds photos without touching the period, running or expired', () => {
    expect(applyPackage(running, photo1000, now)).toEqual({
      kind: 'add_photos',
      packageId: 'pkg-free',
      startsAt: running.startsAt,
      expiresAt: running.expiresAt,
      photoLimit: 1_100,
      photosUsed: 40,
    });
    const expired = { ...running, expiresAt: at(-1) };
    expect(applyPackage(expired, photo1000, now)).toMatchObject({
      expiresAt: at(-1),
      photoLimit: 1_100,
    });
  });

  it('refuses an add-on without a package, or with no days / photos', () => {
    expect(() => applyPackage(null, day1, now)).toThrow(/add-on needs a package/);
    expect(() => applyPackage(null, photo1000, now)).toThrow(/add-on needs a package/);
    expect(() => applyPackage(running, { ...day1, days: 0 }, now)).toThrow(RangeError);
    expect(() => applyPackage(running, { ...photo1000, photoLimit: 0 }, now)).toThrow(RangeError);
  });

  it('refuses invalid packages and dates', () => {
    expect(() => applyPackage(null, { ...d7, days: 0 }, now)).toThrow(RangeError);
    expect(() => applyPackage(null, { ...d7, photoLimit: -5 }, now)).toThrow(RangeError);
    expect(() => applyPackage(null, d7, new Date('nope'))).toThrow(RangeError);
    expect(() => addPackageDays(now, 1.5)).toThrow(RangeError);
  });

  it('expires at expires_at itself', () => {
    expect(packageExpired({ expiresAt: at(1) }, now)).toBe(false);
    expect(packageExpired({ expiresAt: now }, now)).toBe(true);
    expect(packageExpired({ expiresAt: at(-1) }, now)).toBe(true);
  });

  it('counts photos remaining, never below zero', () => {
    expect(photosRemaining({ photoLimit: 100, photosUsed: 40 })).toBe(60);
    expect(photosRemaining({ photoLimit: 100, photosUsed: 100 })).toBe(0);
    expect(photosRemaining({ photoLimit: 100, photosUsed: 120 })).toBe(0);
  });

  it('counts started days left for the studio chip', () => {
    expect(packageDaysLeft({ expiresAt: at(2 * DAY) }, now)).toBe(2);
    expect(packageDaysLeft({ expiresAt: at(2 * DAY + 1) }, now)).toBe(3);
    expect(packageDaysLeft({ expiresAt: at(1) }, now)).toBe(1);
    expect(packageDaysLeft({ expiresAt: now }, now)).toBe(0);
  });

  it('says why uploads are blocked: expiry first, then the photo limit; never without a row', () => {
    expect(packageUploadsBlockedBy(null, now)).toBeNull();
    expect(packageUploadsBlockedBy(running, now)).toBeNull();
    expect(packageUploadsBlockedBy(running, now, 60)).toBeNull();
    expect(packageUploadsBlockedBy(running, now, 61)).toBe(ErrorCode.PHOTO_LIMIT_REACHED);
    expect(packageUploadsBlockedBy({ ...running, photosUsed: 100 }, now)).toBe(
      ErrorCode.PHOTO_LIMIT_REACHED,
    );
    expect(packageUploadsBlockedBy({ ...running, expiresAt: now, photosUsed: 100 }, now)).toBe(
      ErrorCode.PLAN_EXPIRED,
    );
    expect(() => packageUploadsBlockedBy(running, now, 0)).toThrow(RangeError);
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail(' Bob.Smith@Mail.co.th ')).toBe('B***@Mail.co.th');
    expect(maskEmail('ก@example.com')).toBe('ก***@example.com');
  });

  it('reveals nothing for a malformed address', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('alice@')).toBe('***');
  });
});
