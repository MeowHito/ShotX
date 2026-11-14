import type { FrameRect } from './camera';
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

/**
 * `accept` of the "pick a photo" inputs. Named types, not `image/*`: Chrome on Android then opens
 * the photo picker straight away instead of a chooser of apps (camera, Files, Drive...); iOS always
 * shows its own menu and hands HEIC over as JPEG. The camera-app fallback keeps `image/*`.
 */
export const GALLERY_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

/** Canvas access, injectable because jsdom has no canvas. */
export interface CanvasOps {
  /** Decodes an image file with its EXIF orientation applied. */
  decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number }>;
  /** Draws `source` (only its `from` part when given) at `width` × `height`. */
  render(source: CanvasImageSource, width: number, height: number, from?: FrameRect): RenderedImage;
}

export type SelfieSource =
  | { kind: 'file'; blob: Blob }
  | {
      kind: 'frame';
      source: CanvasImageSource;
      width: number;
      height: number;
      /** The part of the frame to keep (the live camera's digital zoom). */
      crop?: FrameRect;
    };

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

/**
 * Decodes, downsizes and re-encodes a selfie as JPEG. Only the live camera's frame goes through
 * the quality gate: the on-phone detector (BlazeFace short range) is made for a face close to
 * the camera and finds no face in a photo from the gallery, typically an event photo where the
 * runner's face is a small part of the picture (owner, 2026-11-14). A picked photo goes straight
 * to the API, which searches with the largest face it finds and says NO_FACE_DETECTED otherwise.
 */
export async function processSelfie(
  input: SelfieSource,
  angle: SelfieAngle,
  deps: SelfieProcessorDeps,
): Promise<ProcessedSelfie> {
  let decoded: { source: CanvasImageSource; width: number; height: number; crop?: FrameRect };
  try {
    decoded = input.kind === 'file' ? await deps.canvas.decode(input.blob) : input;
  } catch {
    return { ok: false, issue: 'unreadable' };
  }
  const area = decoded.crop ?? { x: 0, y: 0, width: decoded.width, height: decoded.height };
  if (area.width <= 0 || area.height <= 0) return { ok: false, issue: 'unreadable' };

  const size = fitLongEdge(area.width, area.height, deps.config.selfie.longEdge);
  const image = deps.canvas.render(decoded.source, size.width, size.height, decoded.crop);
  if (input.kind === 'file') {
    const blob = await image.toJpeg(deps.config.selfie.jpegQuality / 100);
    return { ok: true, blob, ...size };
  }
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
  render(source, width, height, from) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('Canvas 2D is unavailable');
    if (from === undefined) ctx.drawImage(source, 0, 0, width, height);
    else ctx.drawImage(source, from.x, from.y, from.width, from.height, 0, 0, width, height);
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
