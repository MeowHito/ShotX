import type { ComboAnalysis } from './analysis';
import type { Dataset } from './dataset';
import type { Thresholds } from './metrics';

export interface Breakdown {
  label: string;
  positives: number;
  found: number;
}

/** Aggregate counts that explain the misses and false matches. No image data. */
export interface FailureSummary {
  /** Appearances returned, but below FACE_MAYBE: a lower threshold would find them. */
  missedBelowMaybe: number;
  /** Appearances not returned at all above the sweep floor: not indexed, or too dissimilar. */
  missedNotFound: number;
  /** Wrong photos in "ใช่คุณ". */
  falseStrong: number;
  /** Wrong photos in "อาจจะเป็นคุณ" only. */
  falseMaybe: number;
  personsWithFalseStrong: number;
  zeroResultPersons: number;
  /** Zero-result persons whose selfies had no detectable face at all. */
  zeroResultNoFace: number;
  selfiesWithoutFace: number;
  truncatedScans: number;
  /** Synthetic datasets only: recall by face width (share of the photo width) and by pose. */
  bySize?: Breakdown[];
  byPose?: Breakdown[];
}

const SIZE_BUCKETS: Array<[label: string, max: number]> = [
  ['< 1% of width', 0.01],
  ['1–2%', 0.02],
  ['2–4%', 0.04],
  ['4–8%', 0.08],
  ['≥ 8%', Infinity],
];

export function analyzeFailures(
  dataset: Dataset,
  combo: ComboAnalysis,
  thresholds: Thresholds,
): FailureSummary {
  const summary: FailureSummary = {
    missedBelowMaybe: 0,
    missedNotFound: 0,
    falseStrong: 0,
    falseMaybe: 0,
    personsWithFalseStrong: 0,
    zeroResultPersons: 0,
    zeroResultNoFace: 0,
    selfiesWithoutFace: 0,
    truncatedScans: 0,
  };
  const persons = new Map(dataset.persons.map((p) => [p.id, p]));
  const pathOf = new Map(dataset.photos.map((p) => [p.id, p.path]));
  const synthetic = dataset.synthetic;
  const size = new Map(SIZE_BUCKETS.map(([label]) => [label, { positives: 0, found: 0 }]));
  const pose = new Map<string, { positives: number; found: number }>();

  for (const scan of combo.result.scans) {
    const person = persons.get(scan.personId)!;
    const seeds = scan.seedSimilarities.filter((s) => s >= thresholds.strong).length;
    const files = new Map((scan.files[seeds] ?? []).map((f) => [f.photoId, f.similarity]));
    summary.selfiesWithoutFace += scan.selfiesWithoutFace;
    if (scan.truncated) summary.truncatedScans++;

    let returned = 0;
    let falseStrong = 0;
    for (const [photoId, similarity] of files) {
      if (similarity < thresholds.maybe) continue;
      returned++;
      if (person.positives.has(photoId)) continue;
      if (similarity >= thresholds.strong) falseStrong++;
      else summary.falseMaybe++;
    }
    summary.falseStrong += falseStrong;
    if (falseStrong > 0) summary.personsWithFalseStrong++;
    if (person.positives.size > 0 && returned === 0) {
      summary.zeroResultPersons++;
      if (scan.selfiesUsed > 0 && scan.selfiesWithoutFace === scan.selfiesUsed) {
        summary.zeroResultNoFace++;
      }
    }

    for (const photoId of person.positives) {
      const similarity = files.get(photoId);
      const found = similarity !== undefined && similarity >= thresholds.maybe;
      if (!found) {
        if (similarity === undefined) summary.missedNotFound++;
        else summary.missedBelowMaybe++;
      }
      const face = synthetic?.scenes[pathOf.get(photoId)!]?.find((f) => f.personId === person.id);
      if (synthetic && face) {
        const ratio = face.size / synthetic.width;
        const label = SIZE_BUCKETS.find(([, max]) => ratio < max)![0];
        const sizeEntry = size.get(label)!;
        sizeEntry.positives++;
        if (found) sizeEntry.found++;
        const poseEntry = pose.get(face.pose) ?? { positives: 0, found: 0 };
        poseEntry.positives++;
        if (found) poseEntry.found++;
        pose.set(face.pose, poseEntry);
      }
    }
  }

  if (synthetic) {
    summary.bySize = SIZE_BUCKETS.map(([label]) => ({ label, ...size.get(label)! }));
    summary.byPose = [...pose].map(([label, counts]) => ({ label, ...counts }));
  }
  return summary;
}
