import { loadCostConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  chooseOperatingPoint,
  type CostAssumptions,
  estimateCalls,
  type ScoredAt,
  type Targets,
  vary,
} from './analysis';
import { emptyCounts } from './counting-provider';
import { emptyEncodingStats, LEGACY_S3_MAX_BYTES } from './encoding';
import type { ComboResult, IndexStats, PersonScan } from './evaluate';
import { summarize, type Thresholds } from './metrics';

const targets: Targets = {
  strongPrecision: 0.98,
  overallPrecision: 0.9,
  minRecall: 0.8,
  maxZeroResult: 0.1,
  recallTolerance: 0.01,
};
const assumptions: CostAssumptions = {
  cost: loadCostConfig({}),
  scansPer1000Photos: 100,
  retentionMonths: 3,
};

const FIVE_MIB = 5 * 1024 * 1024;

function stats(indexFaces: number, deleteFaces = 0, uploadBytes = 0): IndexStats {
  return {
    photos: 100,
    failedPhotos: 0,
    tiledPhotos: 0,
    facesStored: 400,
    distinctFaces: 380,
    calls: { ...emptyCounts(), indexFaces, deleteFaces },
    encoding: { ...emptyEncodingStats(), photos: 100, totalBytes: uploadBytes },
  };
}

describe('estimateCalls', () => {
  it('scales indexing to 1,000 photos and adds the assumed scans', () => {
    const estimate = estimateCalls(stats(250, 10), 4, assumptions);
    expect(estimate.indexCallsPerPhoto).toBe(2.5);
    expect(estimate.deleteCallsPerPhoto).toBe(0.1);
    expect(estimate.per1000Photos).toMatchObject({
      indexCalls: 2600,
      searchCalls: 400,
      totalCalls: 3000,
      faces: 4000,
    });
    expect(estimate.per1000Photos.callsUsd).toBeCloseTo(3);
    expect(estimate.per1000Photos.callsThb).toBeCloseTo(99);
    expect(estimate.per1000Photos.storageUsdPerMonth).toBeCloseTo(0.04);
    expect(estimate.per1000Photos.storageThbForRetention).toBeCloseTo(3.96);
  });
});

describe('chooseOperatingPoint', () => {
  /** Precision as a function of the threshold, through a single person's counts. */
  function fake(strongP: (s: number) => number, overallP: (t: Thresholds) => number) {
    const summaryWith = (precision: number) =>
      summarize([
        {
          personId: 'v01',
          positives: 1000,
          predicted: 1000,
          tp: Math.round(precision * 1000),
          fp: 1000 - Math.round(precision * 1000),
          fn: 1000 - Math.round(precision * 1000),
        },
      ]);
    return (t: Thresholds): ScoredAt =>
      ({
        strongSummary: summaryWith(strongP(t.strong)),
        overallSummary: summaryWith(overallP(t)),
      }) as ScoredAt;
  }

  it('takes the lowest stable thresholds that meet both targets', () => {
    // Strong precision crosses 98% at 92 but dips at 94; it is stable from 95.
    const strongP = (s: number) => (s === 94 ? 0.97 : s >= 92 ? 0.99 : 0.9);
    const overallP = ({ maybe }: Thresholds) => (maybe >= 86 ? 0.95 : 0.8);
    const at = fake(strongP, overallP);
    expect(
      chooseOperatingPoint([90, 91, 92, 93, 94, 95, 96], [80, 85, 86, 87, 99], at, targets),
    ).toEqual({
      strong: 95,
      maybe: 86,
      strongMet: true,
      overallMet: true,
    });
  });

  it('falls back to the most precise threshold when a target is missed', () => {
    const at = fake(
      (s) => 0.8 + s / 1000,
      () => 0.5,
    );
    expect(chooseOperatingPoint([80, 90, 95], [70, 85], at, targets)).toEqual({
      strong: 95,
      maybe: 95,
      strongMet: false,
      overallMet: false,
    });
  });
});

describe('analyze', () => {
  const positives = new Set(['a', 'b']);
  const scan = (files: Array<[string, number]>): PersonScan => ({
    personId: 'v01',
    selfiesUsed: 1,
    selfiesWithoutFace: 0,
    seedSimilarities: [],
    files: [files.map(([photoId, similarity]) => ({ photoId, similarity }))],
    truncated: false,
  });
  const combo = (
    longEdge: number,
    files: Array<[string, number]>,
    maxBytes = FIVE_MIB,
  ): ComboResult => ({
    index: { longEdge, maxBytes, qualityFilter: 'LOW', tiling: 'never' },
    search: { selfies: 1, expansionSeeds: 0 },
    scans: [scan(files)],
  });

  it('recommends the cheapest option within the recall tolerance', () => {
    const combos = [
      combo(1600, [['a', 99]]),
      combo(2400, [
        ['a', 99],
        ['b', 96],
      ]),
      combo(3500, [
        ['a', 99],
        ['b', 97],
      ]),
    ];
    const analysis = analyze(
      combos,
      {
        'le1600-5mib-low-never': stats(100),
        'le2400-5mib-low-never': stats(150),
        'le3500-5mib-low-never': stats(120),
      },
      () => positives,
      { strong: [90, 95], maybe: [85, 90] },
      targets,
      assumptions,
    );
    expect(analysis.feasible).toBe(true);
    expect(analysis.recommended.index.longEdge).toBe(3500);
    expect(analysis.thresholds).toMatchObject({ strong: 90, maybe: 85 });
    expect(analysis.go.every((g) => g.pass)).toBe(true);
    expect(vary(analysis, 'longEdge').map((c) => c.index.longEdge)).toEqual([1600, 2400, 3500]);
    expect(vary(analysis, 'selfies')).toHaveLength(1);
  });

  it('never recommends a byte limit above 5 MiB, which only the old S3 path took', () => {
    const analysis = analyze(
      [
        combo(3500, [['a', 99]], 2 * 1024 * 1024),
        combo(3500, [['a', 99]]),
        combo(
          3500,
          [
            ['a', 99],
            ['b', 97],
          ],
          LEGACY_S3_MAX_BYTES,
        ),
      ],
      {
        'le3500-2mib-low-never': stats(100, 0, 100 * 2_000_000),
        'le3500-5mib-low-never': stats(100, 0, 100 * 3_000_000),
        'le3500-15mib-low-never': stats(100, 0, 100 * 9_000_000),
      },
      () => positives,
      { strong: [90, 95], maybe: [85, 90] },
      targets,
      assumptions,
    );
    // The 15 MiB option finds more but can't be deployed; of the equal ones the smaller upload wins.
    expect(analysis.recommended.index.maxBytes).toBe(2 * 1024 * 1024);
    expect(analysis.recommended.costAt(analysis.thresholds).per1000Photos.uploadBytes).toBe(
      2_000_000_000,
    );
    expect(vary(analysis, 'maxBytes').map((c) => c.index.maxBytes)).toEqual([
      2 * 1024 * 1024,
      FIVE_MIB,
      LEGACY_S3_MAX_BYTES,
    ]);
  });

  it('reports no-go when recall misses the target', () => {
    const analysis = analyze(
      [combo(3500, [['a', 99]])],
      { 'le3500-5mib-low-never': stats(100) },
      () => positives,
      { strong: [90, 95], maybe: [85, 90] },
      targets,
      assumptions,
    );
    expect(analysis.go.find((g) => g.criterion.includes('recall'))?.pass).toBe(false);
  });
});
