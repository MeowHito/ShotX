import type { PersonScan } from './evaluate';

/** One person's result at one threshold: what they should get back and what they got. */
export interface PersonOutcome {
  personId: string;
  positives: number;
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface Rates {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface Summary {
  /**
   * Micro: TP, FP and FN summed over all persons first, then turned into rates. Every
   * (person, photo) pair weighs the same, so people who appear in many photos dominate.
   */
  micro: Rates & {
    tp: number;
    fp: number;
    fn: number;
    /** 95% Wilson intervals. They treat pairs as independent, so they are too narrow. */
    precisionCi: [number, number] | null;
    recallCi: [number, number] | null;
  };
  /**
   * Macro: rates per person, then averaged, so every person weighs the same. Precision averages
   * persons who got at least one photo back; recall and F1 average persons who appear in at least
   * one photo (F1 is 0 for a person with no correct photo).
   */
  macro: Rates & { precisionPersons: number; recallPersons: number };
  /** Persons who appear in the event but got no photo back. */
  zeroResult: { persons: number; of: number; rate: number | null };
  /** Persons who appear in no photo but still got photos back (all of them false positives). */
  absentWithResults: { persons: number; of: number };
}

export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(successes: number, total: number, z = 1.96): [number, number] | null {
  if (total === 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const centre = (p + z2 / (2 * total)) / (1 + z2 / total);
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / (1 + z2 / total);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function outcome(
  personId: string,
  positives: ReadonlySet<string>,
  predicted: Iterable<string>,
): PersonOutcome {
  let tp = 0;
  let count = 0;
  for (const photoId of predicted) {
    count++;
    if (positives.has(photoId)) tp++;
  }
  return {
    personId,
    positives: positives.size,
    predicted: count,
    tp,
    fp: count - tp,
    fn: positives.size - tp,
  };
}

const mean = (values: number[]) =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

export function summarize(outcomes: readonly PersonOutcome[]): Summary {
  const tp = outcomes.reduce((sum, o) => sum + o.tp, 0);
  const fp = outcomes.reduce((sum, o) => sum + o.fp, 0);
  const fn = outcomes.reduce((sum, o) => sum + o.fn, 0);
  const microPrecision = rate(tp, tp + fp);
  const microRecall = rate(tp, tp + fn);

  const present = outcomes.filter((o) => o.positives > 0);
  const withResults = outcomes.filter((o) => o.predicted > 0);
  const absent = outcomes.filter((o) => o.positives === 0);
  const zero = present.filter((o) => o.predicted === 0).length;

  return {
    micro: {
      precision: microPrecision,
      recall: microRecall,
      f1: f1(microPrecision, microRecall),
      tp,
      fp,
      fn,
      precisionCi: wilson(tp, tp + fp),
      recallCi: wilson(tp, tp + fn),
    },
    macro: {
      precision: mean(withResults.map((o) => o.tp / o.predicted)),
      recall: mean(present.map((o) => o.tp / o.positives)),
      f1: mean(present.map((o) => (2 * o.tp) / (2 * o.tp + o.fp + o.fn))),
      precisionPersons: withResults.length,
      recallPersons: present.length,
    },
    zeroResult: { persons: zero, of: present.length, rate: rate(zero, present.length) },
    absentWithResults: {
      persons: absent.filter((o) => o.predicted > 0).length,
      of: absent.length,
    },
  };
}

export interface Thresholds {
  strong: number;
  maybe: number;
}

export interface ScanAt {
  /** "ใช่คุณ" only: files at or above FACE_STRONG. */
  strong: PersonOutcome[];
  /** "ใช่คุณ" + "อาจจะเป็นคุณ": files at or above FACE_MAYBE. */
  overall: PersonOutcome[];
  /** Mean SearchFacesByImage + SearchFaces calls per scan. */
  searchCallsPerScan: number;
  /** Correct photos at or above FACE_MAYBE that the selfies alone don't reach. */
  expansionOnlyHits: number;
}

/** Applies a FACE_STRONG / FACE_MAYBE pair to raw scans. */
export function scoreScans(
  scans: readonly PersonScan[],
  positivesOf: (personId: string) => ReadonlySet<string>,
  thresholds: Thresholds,
): ScanAt {
  const strong: PersonOutcome[] = [];
  const overall: PersonOutcome[] = [];
  let calls = 0;
  let expansionOnlyHits = 0;
  for (const scan of scans) {
    const seeds = scan.seedSimilarities.filter((s) => s >= thresholds.strong).length;
    const files = scan.files[seeds] ?? [];
    const positives = positivesOf(scan.personId);
    const pick = (min: number) => files.filter((f) => f.similarity >= min).map((f) => f.photoId);
    strong.push(outcome(scan.personId, positives, pick(thresholds.strong)));
    overall.push(outcome(scan.personId, positives, pick(thresholds.maybe)));
    const direct = new Map((scan.files[0] ?? []).map((f) => [f.photoId, f.similarity]));
    expansionOnlyHits += files.filter(
      (f) =>
        f.similarity >= thresholds.maybe &&
        positives.has(f.photoId) &&
        (direct.get(f.photoId) ?? -Infinity) < thresholds.maybe,
    ).length;
    calls += scan.selfiesUsed + seeds;
  }
  return {
    strong,
    overall,
    searchCallsPerScan: scans.length === 0 ? 0 : calls / scans.length,
    expansionOnlyHits,
  };
}

/** Parses "80:99:1" (from:to:step, inclusive) or "85,90,95". */
export function parseGrid(spec: string): number[] {
  const range = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (range) {
    const [from, to, step] = range.slice(1).map(Number) as [number, number, number];
    if (step <= 0 || to < from) throw new RangeError(`Invalid range ${spec}`);
    const values: number[] = [];
    for (let i = 0; from + i * step <= to + 1e-9; i++) {
      values.push(Math.round((from + i * step) * 1000) / 1000);
    }
    return values;
  }
  const values = spec.split(',').map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
    throw new RangeError(`Invalid list ${spec}`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}
