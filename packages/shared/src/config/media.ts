import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int } from './fields';

const edge = int(64, 8192);
const quality = int(1, 100);
const webMaxBytes = int(0, 100_000_000).default(1_500_000);

// Sizes from the spec's upload pipeline. The WebP, poster and video quality values are
// assumptions (the spec doesn't give them).
const mediaEnvSchema = z
  .object({
    MEDIA_THUMB_LONG_EDGE: edge.default(400),
    MEDIA_PREVIEW_LONG_EDGE: edge.default(2048),
    MEDIA_WEB_LONG_EDGE: edge.default(2560),
    MEDIA_WEB_JPEG_QUALITY: quality.default(85),
    /**
     * ADR 0028 (owner, 2026-11-16): web.jpg, the size share viewers download, is at most this many
     * bytes (1.5 MB). The worker lowers the JPEG quality down to MEDIA_WEB_MIN_JPEG_QUALITY, then
     * the long edge, until it fits. 0: no cap.
     */
    MEDIA_WEB_MAX_BYTES: webMaxBytes,
    MEDIA_WEB_MIN_JPEG_QUALITY: quality.default(70),
    MEDIA_WEBP_QUALITY: quality.default(80),
    MEDIA_POSTER_JPEG_QUALITY: quality.default(85),
    MEDIA_VIDEO_PREVIEW_HEIGHT: int(144, 2160).default(720),
    /** x264 constant rate factor for preview.mp4: lower is better quality and bigger files. */
    MEDIA_VIDEO_PREVIEW_CRF: int(0, 51).default(23),
  })
  .refine((e) => e.MEDIA_THUMB_LONG_EDGE <= e.MEDIA_PREVIEW_LONG_EDGE, {
    error: 'MEDIA_THUMB_LONG_EDGE must be less than or equal to MEDIA_PREVIEW_LONG_EDGE',
  })
  .refine((e) => e.MEDIA_WEB_MIN_JPEG_QUALITY <= e.MEDIA_WEB_JPEG_QUALITY, {
    error: 'MEDIA_WEB_MIN_JPEG_QUALITY must be less than or equal to MEDIA_WEB_JPEG_QUALITY',
  });

/** Derivatives the worker writes under `derived/` (see s3-keys). */
export interface MediaConfig {
  /** thumb.webp, the grid image. */
  thumb: { longEdge: number; webpQuality: number };
  /** preview.webp, the lightbox image. */
  preview: { longEdge: number; webpQuality: number };
  /**
   * web.jpg, the "social size" download: at most `maxBytes` (0: no cap; ADR 0028), the quality
   * lowered to `minJpegQuality` and then the long edge reduced until it fits.
   */
  web: { longEdge: number; jpegQuality: number; minJpegQuality: number; maxBytes: number };
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
    web: {
      longEdge: e.MEDIA_WEB_LONG_EDGE,
      jpegQuality: e.MEDIA_WEB_JPEG_QUALITY,
      minJpegQuality: e.MEDIA_WEB_MIN_JPEG_QUALITY,
      maxBytes: e.MEDIA_WEB_MAX_BYTES,
    },
    poster: { jpegQuality: e.MEDIA_POSTER_JPEG_QUALITY },
    videoPreview: { height: e.MEDIA_VIDEO_PREVIEW_HEIGHT, crf: e.MEDIA_VIDEO_PREVIEW_CRF },
  };
}

/**
 * The share download cap (ADR 0028), for the api and media.sweep: share viewers get an image's
 * original only when it is at most `imageMaxBytes` (else web.jpg, which the worker keeps under
 * it); 0 means no cap. The same MEDIA_WEB_MAX_BYTES as MediaConfig.web.maxBytes.
 */
export interface ShareDownloadCapConfig {
  imageMaxBytes: number;
}

export function loadShareDownloadCapConfig(env: Env): ShareDownloadCapConfig {
  const e = parseEnv(z.object({ MEDIA_WEB_MAX_BYTES: webMaxBytes }), env, 'media');
  return { imageMaxBytes: e.MEDIA_WEB_MAX_BYTES };
}
