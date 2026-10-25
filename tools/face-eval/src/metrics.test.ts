import { describe, expect, it } from 'vitest';
import type { PersonScan } from './evaluate';
import { outcome, parseGrid, scoreScans, summarize, wilson } from './metrics';

describe('outcome', () => {
  it('counts true positives, false positives and misses', () => {
    expect(outcome('v01', new Set(['a', 'b', 'c']), ['a', 'x', 'c'])).toEqual({
      personId: 'v01',
      positives: 3,
      predicted: 3,
      tp: 2,
      fp: 1,
      fn: 1,
    });
  });
});

describe('summarize', () => {
  // v01 is in 8 photos and gets 6 right plus 2 wrong; v02 is in 2 and gets 1 right;
  // v03 is in 1 and gets nothing; v04 is in none and gets 1 wrong.
  const outcomes = [
    { personId: 'v01', positives: 8, predicted: 8, tp: 6, fp: 2, fn: 2 },
    { personId: 'v02', positives: 2, predicted: 1, tp: 1, fp: 0, fn: 1 },
    { personId: 'v03', positives: 1, predicted: 0, tp: 0, fp: 0, fn: 1 },
    { personId: 'v04', positives: 0, predicted: 1, tp: 0, fp: 1, fn: 0 },
  ];
  const summary = summarize(outcomes);

  it('computes micro rates from summed counts', () => {
    expect(summary.micro).toMatchObject({ tp: 7, fp: 3, fn: 4 });
    expect(summary.micro.precision).toBeCloseTo(7 / 10);
    expect(summary.micro.recall).toBeCloseTo(7 / 11);
    expect(summary.micro.f1).toBeCloseTo((2 * 0.7 * (7 / 11)) / (0.7 + 7 / 11));
  });

  it('computes macro rates per person, then averages', () => {
    // Precision over persons with results: v01 0.75, v02 1, v04 0.
    expect(summary.macro.precision).toBeCloseTo((0.75 + 1 + 0) / 3);
    expect(summary.macro.precisionPersons).toBe(3);
    // Recall and F1 over persons in at least one photo: v01, v02, v03.
    expect(summary.macro.recall).toBeCloseTo((0.75 + 0.5 + 0) / 3);
    expect(summary.macro.f1).toBeCloseTo((12 / 16 + 2 / 3 + 0) / 3);
    expect(summary.macro.recallPersons).toBe(3);
  });

  it('counts zero-result persons among those present and flags absent persons with results', () => {
    expect(summary.zeroResult).toEqual({ persons: 1, of: 3, rate: 1 / 3 });
    expect(summary.absentWithResults).toEqual({ persons: 1, of: 1 });
  });

  it('leaves undefined rates as null', () => {
    const empty = summarize([{ personId: 'v01', positives: 0, predicted: 0, tp: 0, fp: 0, fn: 0 }]);
    expect(empty.micro.precision).toBeNull();
    expect(empty.micro.recall).toBeNull();
    expect(empty.micro.f1).toBeNull();
    expect(empty.zeroResult.rate).toBeNull();
  });
});

describe('wilson', () => {
  it('matches known intervals', () => {
    const [lo, hi] = wilson(95, 100)!;
    expect(lo).toBeCloseTo(0.8882, 3);
    expect(hi).toBeCloseTo(0.9785, 3);
    expect(wilson(10, 10)![1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('parseGrid', () => {
  it('parses ranges and lists', () => {
    expect(parseGrid('80:84:2')).toEqual([80, 82, 84]);
    expect(parseGrid('90:91:0.5')).toEqual([90, 90.5, 91]);
    expect(parseGrid('95, 85,90,85')).toEqual([85, 90, 95]);
    expect(() => parseGrid('90:80:1')).toThrow(RangeError);
    expect(() => parseGrid('a,b')).toThrow(RangeError);
  });
});

describe('scoreScans', () => {
  const scan: PersonScan = {
    personId: 'v01',
    selfiesUsed: 3,
    selfiesWithoutFace: 0,
    seedSimilarities: [99, 96],
    files: [
      [
        { photoId: 'a', similarity: 99 },
        { photoId: 'b', similarity: 90 },
        { photoId: 'x', similarity: 86 },
        { photoId: 'c', similarity: 80 },
      ],
      [
        { photoId: 'a', similarity: 99 },
        { photoId: 'c', similarity: 93 },
        { photoId: 'b', similarity: 90 },
        { photoId: 'x', similarity: 86 },
      ],
      [
        { photoId: 'a', similarity: 99 },
        { photoId: 'c', similarity: 93 },
        { photoId: 'b', similarity: 90 },
        { photoId: 'd', similarity: 88 },
        { photoId: 'x', similarity: 86 },
      ],
    ],
    truncated: false,
  };
  const positives = new Set(['a', 'b', 'c', 'd']);

  it('uses the seeds at or above FACE_STRONG and buckets by both thresholds', () => {
    const at95 = scoreScans([scan], () => positives, { strong: 95, maybe: 87 });
    expect(at95.strong[0]).toMatchObject({ tp: 1, fp: 0, fn: 3 });
    expect(at95.overall[0]).toMatchObject({ tp: 4, fp: 0, fn: 0 });
    expect(at95.searchCallsPerScan).toBe(5);
    expect(at95.expansionOnlyHits).toBe(2);

    const at97 = scoreScans([scan], () => positives, { strong: 97, maybe: 85 });
    expect(at97.overall[0]).toMatchObject({ tp: 3, fp: 1, fn: 1 });
    expect(at97.searchCallsPerScan).toBe(4);
    expect(at97.expansionOnlyHits).toBe(1);
  });
});
