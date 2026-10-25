import type { SelfieGateConfig } from './quality-gate';

/**
 * What the share page's scan flow needs, read from the environment on the server
 * (lib/server/config `clientFaceConfig`) and passed to the client as props.
 */
export interface ClientFaceConfig {
  /** FACE_SELFIE_LONG_EDGE and FACE_SELFIE_JPEG_QUALITY (shared with the API). */
  selfie: { longEdge: number; jpegQuality: number };
  /** FACE_MAX_SELFIES: angles collected at most (front, left, right). */
  maxSelfies: number;
  gate: SelfieGateConfig;
  /**
   * Self-hosted MediaPipe assets (same origin, never a CDN): the directory holding
   * `vision_wasm_internal.{js,wasm}` and the face detector model file.
   */
  detector: { wasmBasePath: string; modelPath: string };
}

/** Download tunables of the share page. */
export interface ClientShareConfig {
  /** How often the client polls GET /zip-jobs/:id. */
  zipPollIntervalMs: number;
  /** Give up polling after this long. */
  zipPollTimeoutMs: number;
  /** ZIP_MAX_FILES: the most files one selection can download. */
  maxSelection: number;
  /** Most photos fetched for one iOS "save to Photos" (navigator.share). */
  iosShareMaxFiles: number;
}
