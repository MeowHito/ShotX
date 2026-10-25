import type { CostConfig } from '@shotx/shared';
import {
  type ComboResult,
  type IndexOption,
  indexKey,
  type IndexStats,
  type SearchOption,
  searchKey,
} from './evaluate';
import { type ScanAt, scoreScans, type Summary, summarize, type Thresholds } from './metrics';

export interface Targets {
  /** FACE_STRONG is the lowest threshold whose "ใช่คุณ" precision stays at or above this. */
  strongPrecision: number;
  /** FACE_MAYBE is the lowest threshold whose strong+maybe precision stays at or above this. */
  overallPrecision: number;
  /** Go criterion: strong+maybe micro recall. */
  minRecall: number;
  /** Go criterion: share of present persons with no photo back. */
  maxZeroResult: number;
  /** Options within this much recall of the best count as equal; the cheapest one wins. */
  recallTolerance: number;
}

export interface CostAssumptions {
  cost: CostConfig;
  /** Scans expected per 1,000 indexed photos. An assumption: replace it with production data. */
  scansPer1000Photos: number;
  /** How long faces stay indexed (face_index_expires_at defaults to last upload + 90 days). */
  retentionMonths: number;
}

export interface CallEstimate {
  indexCallsPerPhoto: number;
  deleteCallsPerPhoto: number;
  searchCallsPerScan: number;
  facesPerPhoto: number;
  per1000Photos: {
    indexCalls: number;
    searchCalls: number;
    totalCalls: number;
    callsUsd: number;
    callsThb: number;
    faces: number;
    storageUsdPerMonth: number;
    storageThbForRetention: number;
  };
}

export interface ScoredAt extends ScanAt {
  strongSummary: Summary;
  overallSummary: Summary;
}

export interface OperatingPoint extends Thresholds {
  strongMet: boolean;
  overallMet: boolean;
}

export interface ComboAnalysis {
  key: string;
  index: IndexOption;
  search: SearchOption;
  result: ComboResult;
  stats: IndexStats;
  operatingPoint: OperatingPoint;
  at: (thresholds: Thresholds) => ScoredAt;
  costAt: (thresholds: Thresholds) => CallEstimate;
}

export const comboKey = (index: IndexOption, search: SearchOption) =>
  `${indexKey(index)}/${searchKey(search)}`;

export function estimateCalls(
  stats: IndexStats,
  searchCallsPerScan: number,
  assumptions: CostAssumptions,
): CallEstimate {
  const photos = Math.max(1, stats.photos);
  const indexCallsPerPhoto = stats.calls.indexFaces / photos;
  const deleteCallsPerPhoto = stats.calls.deleteFaces / photos;
  const facesPerPhoto = stats.facesStored / photos;
  const indexCalls = 1000 * (indexCallsPerPhoto + deleteCallsPerPhoto);
  const searchCalls = assumptions.scansPer1000Photos * searchCallsPerScan;
  const totalCalls = indexCalls + searchCalls;
  const { cost } = assumptions;
  const callsUsd = totalCalls * cost.rekognitionCall;
  const faces = 1000 * facesPerPhoto;
  const storageUsdPerMonth = faces * cost.rekognitionFaceMonth;
  return {
    indexCallsPerPhoto,
    deleteCallsPerPhoto,
    searchCallsPerScan,
    facesPerPhoto,
    per1000Photos: {
      indexCalls,
      searchCalls,
      totalCalls,
      callsUsd,
      callsThb: callsUsd * cost.usdThb,
      faces,
      storageUsdPerMonth,
      storageThbForRetention: storageUsdPerMonth * assumptions.retentionMonths * cost.usdThb,
    },
  };
}

/** Precision with "nothing returned" counted as meeting the target. */
const precisionOf = (summary: Summary) => summary.micro.precision ?? 1;

/**
 * The lowest FACE_STRONG whose strong precision meets the target at it and at every higher grid
 * value (so a lucky dip doesn't decide), then the lowest FACE_MAYBE ≤ FACE_STRONG that does the
 * same for strong+maybe precision. Falls back to the most precise value when a target is missed.
 */
export function chooseOperatingPoint(
  strongGrid: readonly number[],
  maybeGrid: readonly number[],
  at: (thresholds: Thresholds) => ScoredAt,
  targets: Targets,
): OperatingPoint {
  const strongs = [...strongGrid].sort((a, b) => a - b);
  let strong: number | undefined;
  for (let i = strongs.length - 1; i >= 0; i--) {
    const s = strongs[i]!;
    if (precisionOf(at({ strong: s, maybe: s }).strongSummary) < targets.strongPrecision) break;
    strong = s;
  }
  const strongMet = strong !== undefined;
  if (strong === undefined) {
    strong = strongs.reduce((best, s) => {
      const p = precisionOf(at({ strong: s, maybe: s }).strongSummary);
      return p > precisionOf(at({ strong: best, maybe: best }).strongSummary) ? s : best;
    }, strongs.at(-1)!);
  }

  const maybes = [...new Set([...maybeGrid.filter((m) => m <= strong), strong])].sort(
    (a, b) => a - b,
  );
  let maybe: number | undefined;
  for (let i = maybes.length - 1; i >= 0; i--) {
    const m = maybes[i]!;
    if (precisionOf(at({ strong, maybe: m }).overallSummary) < targets.overallPrecision) break;
    maybe = m;
  }
  return { strong, maybe: maybe ?? strong, strongMet, overallMet: maybe !== undefined };
}

export interface Analysis {
  combos: ComboAnalysis[];
  recommended: ComboAnalysis;
  /** False when no option met both precision targets; `recommended` is then the best F1. */
  feasible: boolean;
  thresholds: OperatingPoint;
  go: Array<{ criterion: string; target: string; actual: number | null; pass: boolean }>;
}

export function analyze(
  combos: readonly ComboResult[],
  indexStats: Readonly<Record<string, IndexStats>>,
  positivesOf: (personId: string) => ReadonlySet<string>,
  grids: { strong: readonly number[]; maybe: readonly number[] },
  targets: Targets,
  assumptions: CostAssumptions,
): Analysis {
  const analyses = combos.map((result): ComboAnalysis => {
    const memo = new Map<string, ScoredAt>();
    const at = (t: Thresholds): ScoredAt => {
      const key = `${t.strong}|${t.maybe}`;
      let scored = memo.get(key);
      if (!scored) {
        const raw = scoreScans(result.scans, positivesOf, t);
        scored = {
          ...raw,
          strongSummary: summarize(raw.strong),
          overallSummary: summarize(raw.overall),
        };
        memo.set(key, scored);
      }
      return scored;
    };
    const stats = indexStats[indexKey(result.index)]!;
    return {
      key: comboKey(result.index, result.search),
      index: result.index,
      search: result.search,
      result,
      stats,
      operatingPoint: chooseOperatingPoint(grids.strong, grids.maybe, at, targets),
      at,
      costAt: (t) => estimateCalls(stats, at(t).searchCallsPerScan, assumptions),
    };
  });

  const recallAt = (c: ComboAnalysis) => c.at(c.operatingPoint).overallSummary.micro.recall ?? 0;
  const f1At = (c: ComboAnalysis) => c.at(c.operatingPoint).overallSummary.micro.f1 ?? 0;
  const callsAt = (c: ComboAnalysis) => c.costAt(c.operatingPoint).per1000Photos.totalCalls;

  const feasible = analyses.filter(
    (c) => c.operatingPoint.strongMet && c.operatingPoint.overallMet,
  );
  let recommended: ComboAnalysis;
  if (feasible.length > 0) {
    const best = Math.max(...feasible.map(recallAt));
    const candidates = feasible.filter((c) => recallAt(c) >= best - targets.recallTolerance);
    recommended = candidates.reduce((a, b) =>
      callsAt(b) < callsAt(a) || (callsAt(b) === callsAt(a) && recallAt(b) > recallAt(a)) ? b : a,
    );
  } else {
    recommended = analyses.reduce((a, b) => (f1At(b) > f1At(a) ? b : a));
  }

  const thresholds = recommended.operatingPoint;
  const scored = recommended.at(thresholds);
  const overall = scored.overallSummary;
  const strongP = scored.strongSummary.micro.precision;
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const go = [
    {
      criterion: '"ใช่คุณ" micro precision',
      target: `≥ ${pct(targets.strongPrecision)}`,
      actual: strongP,
      pass: (strongP ?? 0) >= targets.strongPrecision,
    },
    {
      criterion: 'strong+maybe micro precision',
      target: `≥ ${pct(targets.overallPrecision)}`,
      actual: overall.micro.precision,
      pass: (overall.micro.precision ?? 0) >= targets.overallPrecision,
    },
    {
      criterion: 'strong+maybe micro recall',
      target: `≥ ${pct(targets.minRecall)}`,
      actual: overall.micro.recall,
      pass: (overall.micro.recall ?? 0) >= targets.minRecall,
    },
    {
      criterion: 'zero-result rate (present persons)',
      target: `≤ ${pct(targets.maxZeroResult)}`,
      actual: overall.zeroResult.rate,
      pass: (overall.zeroResult.rate ?? 1) <= targets.maxZeroResult,
    },
  ];
  return { combos: analyses, recommended, feasible: feasible.length > 0, thresholds, go };
}

export const DIMENSIONS = [
  'longEdge',
  'qualityFilter',
  'tiling',
  'expansionSeeds',
  'selfies',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export function valueOf(combo: ComboAnalysis, dimension: Dimension): string | number {
  return dimension === 'selfies' || dimension === 'expansionSeeds'
    ? combo.search[dimension]
    : combo.index[dimension];
}

/** Combos that differ from the recommended one in `dimension` only, in grid order. */
export function vary(analysis: Analysis, dimension: Dimension): ComboAnalysis[] {
  const base = analysis.recommended;
  return analysis.combos.filter((c) =>
    DIMENSIONS.every((d) => d === dimension || valueOf(c, d) === valueOf(base, d)),
  );
}
