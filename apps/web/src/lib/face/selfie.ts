import type { ClientFaceConfig, SelfieLimits } from './config';
import type { DetectorLoader } from './detector';
import { evaluateSelfie, meanLuma, type SelfieAngle, type SelfieIssue } from './quality-gate';

/**
 * Turns a camera frame or a picked file into an upload-ready selfie: downscaled so the long edge
 * is at most FACE_SELFIE_LONG_EDGE, checked by the quality gate, encoded as JPEG.
 *
 * Privacy: everything stays in memory (canvas, Blob). Nothing is written to localStorage,
 * IndexedDB, the Cache API or logs, and errors never carry image data.
 */

export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface RenderedImage {
  /** What the detector reads (a canvas in the browser). */
  surface: CanvasImageSource;
  pixels: Pixels;
  toJpeg(quality: number): Promise<Blob>;
}

/** Canvas access, injectable because jsdom has no canvas. */
export interface CanvasOps {
  /** Decodes an image file with its EXIF orientation applied. */
  decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number }>;
  render(source: CanvasImageSource, width: number, height: number): RenderedImage;
}

export type SelfieSource =
  | { kind: 'file'; blob: Blob }
  | { kind: 'frame'; source: CanvasImageSource; width: number; height: number };

export type ProcessedSelfie =
  { ok: true; blob: Blob; width: number; height: number } | { ok: false; issue: SelfieIssue };

export interface SelfieProcessorDeps {
  /** `selfie` comes from the API (share meta), `gate` from the web config. */
  config: Pick<SelfieLimits, 'selfie'> & Pick<ClientFaceConfig, 'gate'>;
  canvas: CanvasOps;
  loadDetector: DetectorLoader;
}

/** The size that fits `longEdge` without upscaling. */
export function fitLongEdge(width: number, height: number, longEdge: number) {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function processSelfie(
  input: SelfieSource,
  angle: SelfieAngle,
  deps: SelfieProcessorDeps,
): Promise<ProcessedSelfie> {
  let decoded: { source: CanvasImageSource; width: number; height: number };
  try {
    decoded = input.kind === 'file' ? await deps.canvas.decode(input.blob) : input;
  } catch {
    return { ok: false, issue: 'unreadable' };
  }
  if (decoded.width <= 0 || decoded.height <= 0) return { ok: false, issue: 'unreadable' };

  const size = fitLongEdge(decoded.width, decoded.height, deps.config.selfie.longEdge);
  const image = deps.canvas.render(decoded.source, size.width, size.height);
  const detector = await deps.loadDetector();
  const faces = detector === null ? null : detector.detect(image.surface);
  const face = faces?.length === 1 ? faces[0] : undefined;
  const issue = evaluateSelfie(
    {
      width: size.width,
      height: size.height,
      faces,
      brightness: meanLuma(image.pixels, face),
    },
    angle,
    deps.config.gate,
  );
  if (issue !== null) return { ok: false, issue };
  const blob = await image.toJpeg(deps.config.selfie.jpegQuality / 100);
  return { ok: true, blob, ...size };
}

/** Browser canvas implementation of {@link CanvasOps}. */
export const browserCanvasOps: CanvasOps = {
  async decode(blob) {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  render(source, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('Canvas 2D is unavailable');
    ctx.drawImage(source, 0, 0, width, height);
    return {
      surface: canvas,
      pixels: ctx.getImageData(0, 0, width, height),
      toJpeg: (quality) =>
        new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
            'image/jpeg',
            quality,
          );
        }),
    };
  },
};
