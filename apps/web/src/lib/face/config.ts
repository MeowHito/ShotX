import type { SelfieGateConfig } from './quality-gate';

/**
 * Web-only settings of the scan flow, read from the environment on the server
 * (lib/server/config `clientFaceConfig`) and passed to the client as props. The API's face
 * settings (FACE_MAX_SELFIES, FACE_SELFIE_LONG_EDGE, FACE_SELFIE_JPEG_QUALITY) are not here: the
 * page reads them from the API (share meta or `GET /s/:token/face-deletion`), so the client can't
 * disagree with the API.
 */
export interface ClientFaceConfig {
  gate: SelfieGateConfig;
  /**
   * Self-hosted MediaPipe assets (same origin, never a CDN): the directory holding
   * `vision_wasm_internal.{js,wasm}` and the face detector model file.
   */
  detector: { wasmBasePath: string; modelPath: string };
}

/** The API's selfie limits, from share meta or face-deletion info. */
export interface SelfieLimits {
  /** FACE_MAX_SELFIES: angles collected at most (front, left, right). */
  maxSelfies: number;
  /** FACE_SELFIE_LONG_EDGE and FACE_SELFIE_JPEG_QUALITY. */
  selfie: { longEdge: number; jpegQuality: number };
}

/** Web-only download tunables of the share page. ZIP_MAX_FILES comes from share meta. */
export interface ClientShareConfig {
  /** How often the client polls GET /s/:token/zip-jobs/:id. */
  zipPollIntervalMs: number;
  /** Give up polling after this long. */
  zipPollTimeoutMs: number;
  /** Most photos fetched for one iOS "save to Photos" (navigator.share). */
  iosShareMaxFiles: number;
}
