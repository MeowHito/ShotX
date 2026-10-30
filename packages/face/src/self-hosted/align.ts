import type { RgbImage } from './raster';

/** Side of the aligned crop that ArcFace-style recognisers take. */
export const ALIGNED_SIZE = 112;

/**
 * Where the five landmarks (subject's right eye, left eye, nose tip, right and left mouth corners)
 * land in the 112 × 112 crop: the ArcFace template that OpenCV's FaceRecognizerSF also uses.
 */
export const ARCFACE_TEMPLATE: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** x' = a·x − b·y + tx, y' = b·x + a·y + ty (rotation, uniform scale, translation). */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares similarity transform from `src` to `dst` points (Umeyama without reflection),
 * the estimate skimage's SimilarityTransform and OpenCV's alignCrop make.
 */
export function estimateSimilarity(
  src: readonly (readonly [number, number])[],
  dst: readonly (readonly [number, number])[],
): Similarity {
  const n = src.length;
  if (n !== dst.length || n < 2) throw new RangeError('Need matching point lists of 2 or more');
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]![0];
    sy += src[i]![1];
    dx += dst[i]![0];
    dy += dst[i]![1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i]![0] - sx;
    const py = src[i]![1] - sy;
    const qx = dst[i]![0] - dx;
    const qy = dst[i]![1] - dy;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    norm += px * px + py * py;
  }
  if (norm === 0) throw new RangeError('Source points are all the same');
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

/**
 * Warps `image` with `transform` (source → crop) into a size × size RGB crop, sampling each crop
 * pixel at the inverse-mapped source position with bilinear interpolation; outside the image is
 * black (OpenCV warpAffine with INTER_LINEAR and a constant 0 border).
 */
export function warpSimilarity(image: RgbImage, transform: Similarity, size: number): Uint8Array {
  const { a, b, tx, ty } = transform;
  const det = a * a + b * b;
  if (det === 0) throw new RangeError('Degenerate transform');
  // Inverse of [[a, −b], [b, a]] is [[a, b], [−b, a]] / det.
  const ia = a / det;
  const ib = b / det;
  const out = new Uint8Array(size * size * 3);
  const { width, height, data } = image;
  const pixel = (x: number, y: number, c: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + c]!;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const ux = u - tx;
      const vy = v - ty;
      const x = ia * ux + ib * vy;
      const y = -ib * ux + ia * vy;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      for (let c = 0; c < 3; c++) {
        const top = pixel(x0, y0, c) * (1 - fx) + pixel(x0 + 1, y0, c) * fx;
        const bottom = pixel(x0, y0 + 1, c) * (1 - fx) + pixel(x0 + 1, y0 + 1, c) * fx;
        out[(v * size + u) * 3 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/** The aligned 112 × 112 RGB crop of the face with these landmarks. */
export function alignFace(
  image: RgbImage,
  landmarks: readonly (readonly [number, number])[],
): Uint8Array {
  return warpSimilarity(image, estimateSimilarity(landmarks, ARCFACE_TEMPLATE), ALIGNED_SIZE);
}
