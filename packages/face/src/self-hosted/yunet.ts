import type { FaceDetectorModel } from '@shotx/shared';
import { iou } from '../geometry';
import { type RgbImage, shrinkRgb } from './raster';
import type { TensorSession } from './session';

/** A detected face in the pixels of the image given to `detectFaces`. */
export interface Detection {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Five landmarks (x, y): the subject's right eye, left eye, nose tip, right and left mouth
   * corners (so the "right eye" is on the left of the image).
   */
  landmarks: readonly (readonly [number, number])[];
  /** Detector score, 0–1. */
  score: number;
}

export interface DetectOptions {
  /** Detections below this score are dropped (FACE_DETECTOR_MIN_SCORE). */
  minScore: number;
  /** Non-maximum suppression IoU (FACE_DETECTOR_NMS_IOU). */
  nmsIou: number;
  /** Long edge the image is detected at, never upscaled (FACE_DETECTOR_LONG_EDGE). */
  longEdge: number;
  /** Overlap of neighbouring windows, as a fraction of the window (FACE_DETECTOR_WINDOW_OVERLAP). */
  windowOverlap: number;
  /** A box this close to an inner window edge (fraction of the window) is cut off and dropped. */
  edgeEpsilon: number;
}

/** A rectangle of the detection image that one network pass sees, at most input × input. */
interface Window {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Start offsets of windows of `size` covering `length` with at least `overlap` × size shared
 * between neighbours, spread evenly so the first starts at 0 and the last ends at `length`.
 */
export function windowStarts(length: number, size: number, overlap: number): number[] {
  if (length <= size) return [0];
  const step = size * (1 - overlap);
  const count = Math.ceil((length - size) / step) + 1;
  return Array.from({ length: count }, (_, k) => Math.round((k * (length - size)) / (count - 1)));
}

/** Greedy non-maximum suppression: best score first, dropping boxes above `threshold` IoU. */
export function nonMaximumSuppression(detections: readonly Detection[], threshold: number) {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const candidate of sorted) {
    if (kept.every((k) => iou(k, candidate) <= threshold)) kept.push(candidate);
  }
  return kept;
}

/**
 * Copies `window` of `image` into the network input: 1 × 3 × size × size, BGR planes, raw 0–255
 * values, zero padding right and below (what OpenCV's FaceDetectorYN feeds YuNet).
 */
export function yunetInput(image: RgbImage, window: Window, size: number): Float32Array {
  const plane = size * size;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < window.height; y++) {
    let src = ((window.top + y) * image.width + window.left) * 3;
    let dst = y * size;
    for (let x = 0; x < window.width; x++, src += 3, dst++) {
      input[dst] = image.data[src + 2]!; // B
      input[plane + dst] = image.data[src + 1]!; // G
      input[2 * plane + dst] = image.data[src]!; // R
    }
  }
  return input;
}

/** The network outputs of one pass, by name (`cls_8`, `obj_8`, `bbox_8`, `kps_8`, …). */
export type YunetOutputs = Readonly<Record<string, Float32Array>>;

/**
 * Decodes YuNet's anchor-free outputs (2023mar) as OpenCV's FaceDetectorYN does: per stride and
 * cell, score = sqrt(clamp(cls) × clamp(obj)); box centre and landmarks are offsets in cells, box
 * size is exp(·) × stride. Coordinates are in network-input pixels.
 */
export function decodeYunet(
  outputs: YunetOutputs,
  model: Pick<FaceDetectorModel, 'inputSize' | 'strides'>,
  minScore: number,
): Detection[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const faces: Detection[] = [];
  for (const stride of model.strides) {
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    const kps = outputs[`kps_${stride}`];
    if (!cls || !obj || !bbox || !kps) throw new Error(`YuNet output for stride ${stride} missing`);
    const cols = Math.floor(model.inputSize / stride);
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(clamp(cls[idx]!) * clamp(obj[idx]!));
      if (score < minScore) continue;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const cx = (c + bbox[idx * 4]!) * stride;
      const cy = (r + bbox[idx * 4 + 1]!) * stride;
      const width = Math.exp(bbox[idx * 4 + 2]!) * stride;
      const height = Math.exp(bbox[idx * 4 + 3]!) * stride;
      const landmarks = Array.from(
        { length: 5 },
        (_, n) =>
          [
            (kps[idx * 10 + 2 * n]! + c) * stride,
            (kps[idx * 10 + 2 * n + 1]! + r) * stride,
          ] as const,
      );
      faces.push({ left: cx - width / 2, top: cy - height / 2, width, height, landmarks, score });
    }
  }
  return faces;
}

function mapDetection(d: Detection, scale: number, dx: number, dy: number): Detection {
  return {
    left: d.left * scale + dx,
    top: d.top * scale + dy,
    width: d.width * scale,
    height: d.height * scale,
    landmarks: d.landmarks.map(([x, y]) => [x * scale + dx, y * scale + dy] as const),
    score: d.score,
  };
}

/** True when the box comes within `epsilon` px of a window edge that is inside the image. */
function touchesInnerEdge(d: Detection, w: Window, image: RgbImage, epsilon: number): boolean {
  return (
    (w.left > 0 && d.left <= epsilon) ||
    (w.top > 0 && d.top <= epsilon) ||
    (w.left + w.width < image.width && d.left + d.width >= w.width - epsilon) ||
    (w.top + w.height < image.height && d.top + d.height >= w.height - epsilon)
  );
}

async function runPass(
  session: TensorSession,
  model: FaceDetectorModel,
  image: RgbImage,
  window: Window,
  minScore: number,
): Promise<Detection[]> {
  const size = model.inputSize;
  const outputs = await session.run(yunetInput(image, window, size), [1, 3, size, size]);
  return decodeYunet(outputs, model, minScore);
}

/**
 * Finds faces in `image`. The graph has a fixed square input (640 px), so the image is scaled to
 * `longEdge` and scanned in overlapping windows of that size, plus one pass over the whole image
 * scaled to the input for faces larger than a window. Window detections cut off by an inner
 * window edge are dropped (a neighbour or the whole-image pass holds the face), then everything
 * is merged by non-maximum suppression. Coordinates are in `image` pixels.
 */
export async function detectFaces(
  session: TensorSession,
  model: FaceDetectorModel,
  image: RgbImage,
  options: DetectOptions,
): Promise<Detection[]> {
  const size = model.inputSize;
  const detImage = await shrinkRgb(image, options.longEdge);
  const toImage = image.width / detImage.width;
  const found: Detection[] = [];

  const whole = await shrinkRgb(detImage, size);
  const wholeScale = image.width / whole.width;
  for (const d of await runPass(
    session,
    model,
    whole,
    { left: 0, top: 0, ...dims(whole) },
    options.minScore,
  )) {
    found.push(mapDetection(d, wholeScale, 0, 0));
  }

  if (whole !== detImage) {
    const epsilon = options.edgeEpsilon * size;
    for (const top of windowStarts(detImage.height, size, options.windowOverlap)) {
      for (const left of windowStarts(detImage.width, size, options.windowOverlap)) {
        const window = {
          left,
          top,
          width: Math.min(size, detImage.width - left),
          height: Math.min(size, detImage.height - top),
        };
        for (const d of await runPass(session, model, detImage, window, options.minScore)) {
          if (touchesInnerEdge(d, window, detImage, epsilon)) continue;
          found.push(mapDetection(d, toImage, left * toImage, top * toImage));
        }
      }
    }
  }
  return nonMaximumSuppression(found, options.nmsIou);
}

function dims(image: RgbImage) {
  return { width: image.width, height: image.height };
}
