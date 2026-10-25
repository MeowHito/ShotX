import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int } from './fields';

const edge = int(64, 8192);
const quality = int(1, 100);

// Sizes from the spec's upload pipeline. The WebP, poster and video quality values are
// assumptions (the spec doesn't give them).
const mediaEnvSchema = z
  .object({
    MEDIA_THUMB_LONG_EDGE: edge.default(400),
    MEDIA_PREVIEW_LONG_EDGE: edge.default(2048),
    MEDIA_WEB_LONG_EDGE: edge.default(2560),
    MEDIA_WEB_JPEG_QUALITY: quality.default(85),
    MEDIA_WEBP_QUALITY: quality.default(80),
    MEDIA_POSTER_JPEG_QUALITY: quality.default(85),
    MEDIA_VIDEO_PREVIEW_HEIGHT: int(144, 2160).default(720),
    /** x264 constant rate factor for preview.mp4: lower is better quality and bigger files. */
    MEDIA_VIDEO_PREVIEW_CRF: int(0, 51).default(23),
  })
  .refine((e) => e.MEDIA_THUMB_LONG_EDGE <= e.MEDIA_PREVIEW_LONG_EDGE, {
    error: 'MEDIA_THUMB_LONG_EDGE must be less than or equal to MEDIA_PREVIEW_LONG_EDGE',
  });

/** Derivatives the worker writes under `derived/` (see s3-keys). */
export interface MediaConfig {
  /** thumb.webp, the grid image. */
  thumb: { longEdge: number; webpQuality: number };
  /** preview.webp, the lightbox image. */
  preview: { longEdge: number; webpQuality: number };
  /** web.jpg, the "social size" download. */
  web: { longEdge: number; jpegQuality: number };
  /** poster.jpg, a frame of each video at full resolution. */
  poster: { jpegQuality: number };
  /** preview.mp4: H.264 with +faststart. */
  videoPreview: { height: number; crf: number };
}

export function loadMediaConfig(env: Env): MediaConfig {
  const e = parseEnv(mediaEnvSchema, env, 'media');
  return {
    thumb: { longEdge: e.MEDIA_THUMB_LONG_EDGE, webpQuality: e.MEDIA_WEBP_QUALITY },
    preview: { longEdge: e.MEDIA_PREVIEW_LONG_EDGE, webpQuality: e.MEDIA_WEBP_QUALITY },
    web: { longEdge: e.MEDIA_WEB_LONG_EDGE, jpegQuality: e.MEDIA_WEB_JPEG_QUALITY },
    poster: { jpegQuality: e.MEDIA_POSTER_JPEG_QUALITY },
    videoPreview: { height: e.MEDIA_VIDEO_PREVIEW_HEIGHT, crf: e.MEDIA_VIDEO_PREVIEW_CRF },
  };
}
