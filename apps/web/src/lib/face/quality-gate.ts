/**
 * Client-side quality gate for selfies, before anything is uploaded: exactly one face, large
 * enough, facing the camera (for the front shot) and lit well enough. The server still decides
 * (NO_FACE_DETECTED); this only saves a round trip and says what was wrong with the shot.
 * Thresholds come from config (ClientFaceConfig.gate), never literals.
 */

/**
 * Why a selfie was refused. Each has a short statement of the problem under `capture.issues`
 * (no how-to tips: owner feedback 2026-11-12).
 */
export const SELFIE_ISSUES = [
  'unreadable',
  'noFace',
  'multipleFaces',
  'tooSmall',
  'notFrontal',
  'tooDark',
  'tooBright',
] as const;
export type SelfieIssue = (typeof SELFIE_ISSUES)[number];

/** The optional extra angles (spec: front, slightly left, slightly right). */
export const SELFIE_ANGLES = ['front', 'left', 'right'] as const;
export type SelfieAngle = (typeof SELFIE_ANGLES)[number];

export interface SelfieGateConfig {
  /** Smallest face box width as a share of the image width (0..1). */
  minFaceWidthRatio: number;
  /** Detections below this confidence are ignored (0..1). */
  minScore: number;
  /** Mean luma (0..255) of the face region must lie within these bounds. */
  minBrightness: number;
  maxBrightness: number;
  /**
   * Front shot only: the nose tip may be off the eyes' midpoint by at most this share of the
   * distance between the eyes (a cheap yaw estimate from the detector's keypoints).
   */
  maxNoseOffsetRatio: number;
}

/** A detected face in image pixels; keypoints are normalized (0..1) like MediaPipe's. */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  /** MediaPipe face detector order: right eye, left eye, nose tip, mouth, right ear, left ear. */
  keypoints?: readonly { x: number; y: number }[];
}

export interface SelfieMeasurement {
  width: number;
  height: number;
  /** null when the detector couldn't load: the face checks are skipped (the API still checks). */
  faces: readonly FaceBox[] | null;
  /** Mean luma (0..255) of the face region, or the whole image without a face box. */
  brightness: number;
}

/** The first problem with a selfie, or null when it passes. */
export function evaluateSelfie(
  m: SelfieMeasurement,
  angle: SelfieAngle,
  config: SelfieGateConfig,
): SelfieIssue | null {
  if (m.width <= 0 || m.height <= 0) return 'unreadable';
  if (m.faces !== null) {
    const faces = m.faces.filter((f) => f.score >= config.minScore);
    if (faces.length === 0) return 'noFace';
    if (faces.length > 1) return 'multipleFaces';
    const face = faces[0] as FaceBox;
    if (face.width / m.width < config.minFaceWidthRatio) return 'tooSmall';
    if (angle === 'front' && !isFrontal(face, config.maxNoseOffsetRatio)) return 'notFrontal';
  }
  if (m.brightness < config.minBrightness) return 'tooDark';
  if (m.brightness > config.maxBrightness) return 'tooBright';
  return null;
}

function isFrontal(face: FaceBox, maxOffsetRatio: number): boolean {
  const [rightEye, leftEye, nose] = face.keypoints ?? [];
  if (rightEye === undefined || leftEye === undefined || nose === undefined) return true;
  const eyeDistance = Math.abs(leftEye.x - rightEye.x);
  if (eyeDistance === 0) return false;
  const midX = (leftEye.x + rightEye.x) / 2;
  return Math.abs(nose.x - midX) / eyeDistance <= maxOffsetRatio;
}

/** Mean luma (Rec. 601) of RGBA pixels, optionally only inside a box (pixels). */
export function meanLuma(
  pixels: { data: ArrayLike<number>; width: number; height: number },
  box?: { x: number; y: number; width: number; height: number },
): number {
  const x0 = Math.max(0, Math.floor(box?.x ?? 0));
  const y0 = Math.max(0, Math.floor(box?.y ?? 0));
  const x1 = Math.min(pixels.width, Math.ceil(box ? box.x + box.width : pixels.width));
  const y1 = Math.min(pixels.height, Math.ceil(box ? box.y + box.height : pixels.height));
  let sum = 0;
  let count = 0;
  // Every second pixel each way is plenty for an average.
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * pixels.width + x) * 4;
      sum +=
        0.299 * Number(pixels.data[i]) +
        0.587 * Number(pixels.data[i + 1]) +
        0.114 * Number(pixels.data[i + 2]);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}
