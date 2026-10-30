/**
 * Face models the self-hosted provider can run (ADR 0009). Each entry pins one ONNX file by
 * SHA-256; `@shotx/face`'s `models:download` fetches it from `url` and refuses any other bytes,
 * and the provider checks the hash again when it loads the file. Model files are never committed.
 *
 * Adding a recognition model: an entry here, a migration with its partial HNSW index on
 * `face_vectors` (`embedding::vector(<dimensions>)`, `WHERE model = '<id>'`), and a Phase 0 run
 * that sets its thresholds. InsightFace pretrained weights are never added (non-commercial
 * licence); a production model needs a commercial licence approved by ADR.
 */

/** A model id: lower-case letters, digits and hyphens (it is inlined into SQL as a literal). */
export const FACE_MODEL_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface ModelFile {
  /** File name inside FACE_MODEL_DIR. */
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  licence: string;
  /** Whether the entry is approved for production (legal/DPO review of weights and training data). */
  production: boolean;
  /** Why it is or isn't approved; shown by `models:download`. */
  note: string;
}

export interface FaceDetectorModel extends ModelFile {
  kind: 'yunet';
  /** Fixed input of the ONNX graph, in pixels (square). */
  inputSize: number;
  /** Feature-map strides the graph outputs, in output order. */
  strides: readonly number[];
}

export interface FaceRecognitionModel extends ModelFile {
  kind: 'arcface-112';
  /** Embedding length. The model's HNSW index casts `embedding` to vector(dimensions). */
  dimensions: number;
  /** Input channel order of the aligned 112 × 112 crop. */
  channels: 'rgb' | 'bgr';
  /** Pixel value fed to the network: (value − mean) / std, per channel. */
  mean: number;
  std: number;
  /**
   * Starting values of FACE_STRONG and FACE_MAYBE (100 × cosine) when they are unset. Phase 0
   * (tools/face-eval) sets the real ones.
   */
  thresholds: { strong: number; maybe: number };
}

export const FACE_DETECTOR_MODELS = {
  'yunet-2023mar': {
    kind: 'yunet',
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    bytes: 232_589,
    licence: 'MIT (OpenCV Zoo)',
    production: false,
    note: 'Trained on WIDER FACE; legal/DPO review of the training data before production use.',
    inputSize: 640,
    strides: [8, 16, 32],
  },
} as const satisfies Record<string, FaceDetectorModel>;

export const FACE_RECOGNITION_MODELS = {
  'sface-2021dec': {
    kind: 'arcface-112',
    file: 'face_recognition_sface_2021dec.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    bytes: 38_696_353,
    licence: 'Apache-2.0 (OpenCV Zoo)',
    production: false,
    note: 'Development, demo and Phase 0 baseline only (ADR 0009): training-data terms restrict commercial use.',
    dimensions: 128,
    channels: 'rgb',
    mean: 0,
    std: 1,
    // OpenCV's published SFace operating point is cosine 0.363.
    thresholds: { strong: 50, maybe: 36 },
  },
} as const satisfies Record<string, FaceRecognitionModel>;

export type FaceDetectorModelId = keyof typeof FACE_DETECTOR_MODELS;
export type FaceRecognitionModelId = keyof typeof FACE_RECOGNITION_MODELS;

export const FACE_DETECTOR_MODEL_IDS = Object.keys(FACE_DETECTOR_MODELS) as [
  FaceDetectorModelId,
  ...FaceDetectorModelId[],
];
export const FACE_RECOGNITION_MODEL_IDS = Object.keys(FACE_RECOGNITION_MODELS) as [
  FaceRecognitionModelId,
  ...FaceRecognitionModelId[],
];
