import { loadFaceConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { type BucketOptions, bucketParams, nextSlotUs } from './bucket';
import { mulberry32 } from './testing';
import { type Clock, RateLimitedError, TokenBucket } from './throttling';

const SECOND_US = 1_000_000;

/**
 * The most grants in any half-open window [t, t + windowUs) of a sorted schedule. A window holding
 * the most grants can always be moved right until it starts at a grant, so checking the windows
 * that start at each grant checks every sliding window.
 */
function maxInWindow(sortedSlots: readonly number[], windowUs: number): number {
  let max = 0;
  let end = 0;
  for (let start = 0; start < sortedSlots.length; start++) {
    while (end < sortedSlots.length && sortedSlots[end]! < sortedSlots[start]! + windowUs) end++;
    max = Math.max(max, end - start);
  }
  return max;
}

function manualClock(): Clock & { time: number } {
  const clock = {
    time: 0,
    now: () => clock.time,
    sleep: (ms: number) => {
      clock.time += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

/**
 * Reserves slots the way a busy fleet would: a burst of up to three windows' quota at one instant
 * (the first one hits an idle bucket), a few windows of arrivals at about twice the rate, then an
 * idle gap that sometimes lets the bucket drain completely and sometimes only partly. Arrival
 * times are fractional milliseconds on purpose.
 */
function simulate(options: BucketOptions, seed: number) {
  const clock = manualClock();
  const bucket = new TokenBucket(options, clock);
  const random = mulberry32(seed);
  const { limit, windowUs } = bucket.params;
  const windowMs = windowUs / 1000;
  const arrivals: number[] = [];
  const slots: number[] = [];
  const take = (atMs: number) => {
    clock.time = atMs;
    arrivals.push(atMs * 1000);
    slots.push(bucket.reserve().slotUs);
  };
  let t = 0;
  const coldStart = 3 * limit;
  for (let phase = 0; phase < 6; phase++) {
    const burst = phase === 0 ? coldStart : 1 + Math.floor(random() * 3 * limit);
    for (let i = 0; i < burst; i++) take(t);
    const end = t + windowMs * (1 + random() * 3);
    while (t < end) {
      t += (random() * windowMs) / limit;
      take(t);
    }
    const lastSlotMs = slots.at(-1)! / 1000;
    t = (random() < 0.5 ? Math.max(t, lastSlotMs) : t) + random() * 2 * windowMs;
  }
  return { params: bucket.params, arrivals, slots, coldStart };
}

/** Values FaceConfig can produce: whole TPS from 1 to 1000, burst seconds in (0, 1]. */
const CONFIG_TPS = ['1', '5', '7', '50', '1000'];
const CONFIG_BURST_SECONDS = ['0.05', '0.3', '1'];
/** The bucket API accepts more: fractional rates and bursts above 1 s. */
const API_ONLY_RATES = [0.5, 2.5];
const API_ONLY_BURST_SECONDS = [2.5, 10];

/** Checks the sliding-window guarantee on a simulated schedule. */
function expectGuarantee(options: BucketOptions) {
  const { ratePerSecond, burstSeconds } = options;
  const seed = Math.round(ratePerSecond * 1000 + burstSeconds * 100);
  const { params, arrivals, slots, coldStart } = simulate(options, seed);
  expect(slots.length).toBeGreaterThan(coldStart);

  // The guarantee: every sliding second holds at most floor(rate) grants (one for rates below
  // 1/s), and every window of the bucket holds at most its limit.
  const sorted = [...slots].sort((a, b) => a - b);
  expect(maxInWindow(sorted, SECOND_US)).toBeLessThanOrEqual(
    Math.max(1, Math.floor(ratePerSecond)),
  );
  expect(maxInWindow(sorted, params.windowUs)).toBeLessThanOrEqual(params.limit);
  expect(maxInWindow(sorted, params.burstWindowUs)).toBeLessThanOrEqual(params.burst);

  // Slots stay in arrival order and never come before the arrival. Checked in a plain loop with
  // one assertion: an expect() per slot made the 1000/s cases (tens of thousands of slots) slow
  // enough to hit the test timeout on a loaded CI machine.
  const outOfOrder: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]! < arrivals[i]! || (i > 0 && slots[i]! < slots[i - 1]!)) outOfOrder.push(i);
  }
  expect(outOfOrder).toEqual([]);

  // And the bucket is not slower than it has to be: an idle bucket lets a burst through at once,
  // and three windows' quota is through within three windows plus one burst window.
  expect(slots.slice(0, params.burst).every((slot) => slot === 0)).toBe(true);
  expect(slots[params.burst]).toBeGreaterThan(0);
  expect(slots[coldStart - 1]).toBeLessThan(3 * params.windowUs + params.burstWindowUs);
}

describe('bucketParams', () => {
  it('allows one second of quota per sliding second, in whole microseconds', () => {
    expect(bucketParams({ ratePerSecond: 5, burstSeconds: 1, maxWaitMs: 2000 })).toEqual({
      limit: 5,
      windowUs: 1_000_000,
      burst: 5,
      burstWindowUs: 1_000_000,
      maxWaitUs: 2_000_000,
    });
  });

  it('spreads the second when the burst is smaller, rounding windows up to whole ms', () => {
    expect(bucketParams({ ratePerSecond: 7, burstSeconds: 0.3, maxWaitMs: 0 })).toEqual({
      limit: 7,
      windowUs: 1_000_000,
      burst: 2,
      burstWindowUs: 286_000,
      maxWaitUs: 0,
    });
  });

  // FaceConfig rejects both inputs; the bucket API accepts them.
  it('rounds fractional rates down and caps the burst at one second', () => {
    expect(bucketParams({ ratePerSecond: 2.5, burstSeconds: 10, maxWaitMs: 0 })).toMatchObject({
      limit: 2,
      windowUs: 1_000_000,
      burst: 2,
    });
  });

  // Bucket API only: FaceConfig's lowest rate is 1/s.
  it('allows one call per 1/rate seconds below one call per second', () => {
    expect(bucketParams({ ratePerSecond: 0.3, burstSeconds: 1, maxWaitMs: 0 })).toMatchObject({
      limit: 1,
      windowUs: 3_334_000,
      burst: 1,
      burstWindowUs: 3_334_000,
    });
  });

  it('rejects rates, bursts and waits that make no sense', () => {
    const ok = { ratePerSecond: 5, burstSeconds: 1, maxWaitMs: 0 };
    expect(() => bucketParams({ ...ok, ratePerSecond: 0 })).toThrow(RangeError);
    expect(() => bucketParams({ ...ok, ratePerSecond: Number.NaN })).toThrow(RangeError);
    expect(() => bucketParams({ ...ok, ratePerSecond: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => bucketParams({ ...ok, burstSeconds: -1 })).toThrow(RangeError);
    expect(() => bucketParams({ ...ok, maxWaitMs: -1 })).toThrow(RangeError);
  });
});

describe('nextSlotUs', () => {
  const params = bucketParams({ ratePerSecond: 5, burstSeconds: 0.4, maxWaitMs: 0 });

  it('grants immediately while every window has room', () => {
    expect(nextSlotUs([], 7, params)).toBe(7);
    expect(nextSlotUs([0], 7, params)).toBe(7);
  });

  it('waits for the burst window, then for the one-second window', () => {
    // burst 2 per 400 ms
    expect(nextSlotUs([0, 0], 7, params)).toBe(400_000);
    // limit 5 per second: the 5th latest grant leaves the window at 1 s
    expect(nextSlotUs([800_000, 400_000, 400_000, 0, 0], 800_000, params)).toBe(1_000_000);
  });

  it('never goes back before the newest grant', () => {
    expect(nextSlotUs([500_000], 100, params)).toBe(500_000);
  });
});

describe('sliding-window guarantee', () => {
  // The finding: with the defaults (5 TPS, 1 s burst) the old bucket let 9 calls start within the
  // first second.
  it('lets at most FACE_REKOGNITION_TPS_* calls start in the first second with the defaults', () => {
    const { rateLimit } = loadFaceConfig({}).rekognition;
    const clock = manualClock();
    const bucket = new TokenBucket(
      {
        ratePerSecond: rateLimit.tps.indexFaces,
        burstSeconds: rateLimit.burstSeconds,
        maxWaitMs: Number.POSITIVE_INFINITY,
      },
      clock,
    );
    const slots = Array.from({ length: 20 }, () => bucket.reserve().slotUs);
    expect(slots.filter((slot) => slot < SECOND_US)).toHaveLength(rateLimit.tps.indexFaces);
    expect(maxInWindow(slots, SECOND_US)).toBe(rateLimit.tps.indexFaces);
  });

  // Every combination of config-producible values, read through loadFaceConfig like production.
  for (const tps of CONFIG_TPS) {
    for (const burst of CONFIG_BURST_SECONDS) {
      it(`never exceeds FACE_REKOGNITION_TPS_INDEX_FACES=${tps} in any second with burst ${burst} s`, () => {
        const { rateLimit } = loadFaceConfig({
          FACE_REKOGNITION_TPS_INDEX_FACES: tps,
          FACE_REKOGNITION_BURST_SECONDS: burst,
        }).rekognition;
        expectGuarantee({
          ratePerSecond: rateLimit.tps.indexFaces,
          burstSeconds: rateLimit.burstSeconds,
          maxWaitMs: Number.POSITIVE_INFINITY,
        });
      });
    }
  }

  // Inputs only direct users of the bucket API can pass: a fractional rate or a burst above 1 s.
  const allBursts = [...CONFIG_BURST_SECONDS.map(Number), ...API_ONLY_BURST_SECONDS];
  const apiOnly = [
    ...API_ONLY_RATES.flatMap((rate) => allBursts.map((burst) => [rate, burst] as const)),
    ...CONFIG_TPS.map(Number).flatMap((rate) =>
      API_ONLY_BURST_SECONDS.map((burst) => [rate, burst] as const),
    ),
  ];
  for (const [ratePerSecond, burstSeconds] of apiOnly) {
    it(`never exceeds ${ratePerSecond}/s in any 1-second window with a ${burstSeconds} s burst`, () => {
      expectGuarantee({ ratePerSecond, burstSeconds, maxWaitMs: Number.POSITIVE_INFINITY });
    });
  }
});

describe('TokenBucket', () => {
  it('refuses a call beyond the maximum wait without reserving a slot', () => {
    const clock = manualClock();
    const bucket = new TokenBucket({ ratePerSecond: 1, burstSeconds: 1, maxWaitMs: 400 }, clock);
    bucket.reserve();
    expect(() => bucket.reserve()).toThrow(RateLimitedError);
    clock.time = 700;
    // Had the refusal reserved a slot, this one would be 2 s out.
    expect(bucket.reserve()).toEqual({ slotUs: 1_000_000, waitUs: 300_000 });
  });
});
