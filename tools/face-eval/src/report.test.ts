import { loadCostConfig, loadFaceConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { analyze, type Targets } from './analysis';
import { emptyCounts } from './counting-provider';
import type { ComboResult } from './evaluate';
import { analyzeFailures } from './failures';
import { renderReport, type ReportInput, SYNTHETIC_DISCLAIMER } from './report';
import type { Dataset } from './dataset';
import { emptyEncodingStats, LEGACY_S3_MAX_BYTES } from './encoding';

const targets: Targets = {
  strongPrecision: 0.98,
  overallPrecision: 0.9,
  minRecall: 0.8,
  maxZeroResult: 0.1,
  recallTolerance: 0.01,
};
const assumptions = { cost: loadCostConfig({}), scansPer1000Photos: 100, retentionMonths: 3 };

const dataset: Dataset = {
  dir: '/data/secret-event',
  event: 'Test event',
  photos: [
    { id: 'p1', path: 'finish/IMG_4711.jpg' },
    { id: 'p2', path: 'finish/IMG_4712.jpg' },
  ],
  persons: [{ id: 'volunteer-somchai', positives: new Set(['p1']), selfies: [] }],
  synthetic: undefined,
};

const FIVE_MIB = 5 * 1024 * 1024;
const indexOptions = [
  { tiling: 'never', maxBytes: FIVE_MIB },
  { tiling: 'always', maxBytes: FIVE_MIB },
  { tiling: 'never', maxBytes: LEGACY_S3_MAX_BYTES },
] as const;

const combos: ComboResult[] = indexOptions.map(({ tiling, maxBytes }) => ({
  index: { longEdge: 3500, maxBytes, qualityFilter: 'LOW', tiling },
  search: { selfies: 1, expansionSeeds: 0 },
  scans: [
    {
      personId: 'volunteer-somchai',
      selfiesUsed: 1,
      selfiesWithoutFace: 0,
      seedSimilarities: [],
      files: [
        [
          { photoId: 'p1', similarity: 98 },
          { photoId: 'p2', similarity: 80 },
        ],
      ],
      truncated: false,
    },
  ],
}));

function input(synthetic: boolean, env: Record<string, string> = {}): ReportInput {
  const stats = {
    photos: 2,
    failedPhotos: 0,
    tiledPhotos: 0,
    facesStored: 3,
    distinctFaces: 3,
    calls: { ...emptyCounts(), indexFaces: 2 },
    encoding: {
      ...emptyEncodingStats(),
      photos: 2,
      images: 2,
      degradedImages: 1,
      degradedPhotos: 1,
      degradedFullImages: 1,
      minQuality: 75,
      totalBytes: 7 * 1024 * 1024,
      largestImageBytes: FIVE_MIB,
    },
  };
  const analysis = analyze(
    combos,
    {
      'le3500-5mib-low-never': stats,
      'le3500-5mib-low-always': { ...stats, calls: { ...stats.calls, indexFaces: 10 } },
      'le3500-15mib-low-never': stats,
    },
    (id) => dataset.persons.find((p) => p.id === id)!.positives,
    { strong: [90, 95], maybe: [85, 90] },
    targets,
    assumptions,
  );
  return {
    generatedAt: new Date('2026-10-25T00:00:00Z'),
    commit: 'abc1234',
    provider: 'test',
    faceModelVersion: undefined,
    dataset: {
      event: dataset.event,
      synthetic,
      photos: 2,
      photosWithoutVolunteers: 1,
      persons: 1,
      personsAbsent: 0,
      appearances: 1,
      selfies: 1,
    },
    config: loadFaceConfig(env),
    grids: { strong: [90, 95], maybe: [85, 90] },
    targets,
    assumptions,
    analysis,
    failures: analyzeFailures(dataset, analysis.recommended, analysis.thresholds),
    harnessCalls: emptyCounts(),
  };
}

describe('renderReport', () => {
  it('opens synthetic reports with the disclaimer', () => {
    const report = renderReport(input(true));
    expect(report.split('\n').slice(0, SYNTHETIC_DISCLAIMER.length)).toEqual(SYNTHETIC_DISCLAIMER);
    expect(report).toContain('NOT A BASIS FOR PRODUCTION THRESHOLDS');
  });

  it('has no disclaimer for real data and recommends values for every option', () => {
    const report = renderReport(input(false));
    expect(report).not.toContain('SYNTHETIC DATA');
    for (const key of [
      'FACE_STRONG',
      'FACE_MAYBE',
      'FACE_INDEX_LONG_EDGE',
      'FACE_INDEX_MAX_BYTES',
      'FACE_INDEX_QUALITY_FILTER',
      'FACE_INDEX_TILING',
      'FACE_EXPANSION_SEEDS',
      'FACE_MAX_SELFIES',
    ]) {
      expect(report).toContain(key);
    }
    expect(report).toContain('Rekognition calls per 1,000 photos');
    expect(report).toContain('## Go / no-go');
  });

  it('shows the FACE_INDEX_TILING value of the run next to the recommendation', () => {
    const row = (report: string) =>
      report.split('\n').find((line) => line.includes('`FACE_INDEX_TILING`'));
    expect(row(renderReport(input(false)))).toMatch(/\| (never|always) \| signal \|$/);
    expect(row(renderReport(input(false, { FACE_INDEX_TILING: 'always' })))).toMatch(
      /\| always \|$/,
    );
  });

  it('compares byte limits, marks the old S3 path as reference only and never recommends it', () => {
    const report = renderReport(input(false));
    const row = report.split('\n').find((line) => line.includes('`FACE_INDEX_MAX_BYTES`'));
    expect(row).toMatch(/\| 5 MiB \(bytes\) \| 5 MiB \(bytes\) \|$/);
    expect(report).toContain('### Index image byte limit');
    expect(report).toContain('15 MiB (old S3 path, reference only)');
    expect(report).toContain('## Index image encoding');
    expect(report).toContain('`le3500-15mib-low-never`');
    expect(report).toContain('Upload to Rekognition per 1,000 photos');
  });

  it('says on synthetic reports that no real faces were used', () => {
    expect(renderReport(input(true))).toContain('No real event');
  });

  it('contains aggregate numbers only: no person ids, photo names or dataset paths', () => {
    const report = renderReport(input(false));
    expect(report).not.toContain('somchai');
    expect(report).not.toContain('IMG_4711');
    expect(report).not.toContain('secret-event');
  });
});
