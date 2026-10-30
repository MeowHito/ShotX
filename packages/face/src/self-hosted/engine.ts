import {
  FACE_DETECTOR_MODELS,
  FACE_RECOGNITION_MODELS,
  type FaceDetectorModel,
  type FaceConfig,
  type FaceRecognitionModel,
} from '@shotx/shared';
import { EXCEEDS_MAX_FACES, SMALL_BOUNDING_BOX } from '../provider';
import { RateLimitedError } from '../throttling';
import type { BoundingBox } from '../types';
import { alignFace } from './align';
import { embedFace } from './embed';
import { type DecodeLimits, decodeRgb, type RgbImage } from './raster';
import { openOnnxSession, readModelFile, type TensorSession } from './session';
import { type Detection, type DetectOptions, detectFaces } from './yunet';

export interface EmbeddedFace {
  bbox: BoundingBox;
  /** Detector score as 0–100, like Rekognition's Confidence. */
  confidence: number;
  embedding: Float32Array;
}

export interface SkippedFace {
  bbox: BoundingBox;
  reasons: string[];
}

export interface FaceAnalysis {
  faces: EmbeddedFace[];
  unindexed: SkippedFace[];
}

/** Detection plus embedding, behind which the model files and ONNX Runtime sit. */
export interface FaceEngine {
  /** FACE_RECOGNITION_MODELS id of the embeddings. */
  readonly model: string;
  readonly dimensions: number;
  /**
   * Every face in the image, largest first: faces narrower than `minFacePx` are skipped with
   * SMALL_BOUNDING_BOX, faces beyond the `maxFaces` largest with EXCEEDS_MAX_FACES (Rekognition's
   * MaxFaces keeps the largest), the rest are embedded.
   */
  analyze(image: Uint8Array, maxFaces: number): Promise<FaceAnalysis>;
  /** The embedding of the largest face (Rekognition's rule for search images), or null. */
  embedLargest(image: Uint8Array): Promise<Float32Array | null>;
}

/**
 * At most `concurrency` holders at once; a caller that would wait longer than `maxWaitMs` fails
 * with RateLimitedError (the API answers RATE_LIMITED), so a burst of scans can't queue up
 * without bound behind CPU-bound inference.
 */
export class InferenceSlots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxWaitMs: number,
  ) {
    if (!(concurrency >= 1)) throw new RangeError('concurrency must be at least 1');
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new RateLimitedError('face-inference', this.maxWaitMs));
      }, this.maxWaitMs);
      this.waiting.push(grant);
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

function toRatios(d: Detection, image: RgbImage): BoundingBox {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const left = clamp(d.left / image.width);
  const top = clamp(d.top / image.height);
  return {
    left,
    top,
    width: clamp((d.left + d.width) / image.width) - left,
    height: clamp((d.top + d.height) / image.height) - top,
  };
}

const area = (d: Detection) => d.width * d.height;

export interface OnnxFaceEngineOptions {
  detector: FaceDetectorModel;
  recognizer: FaceRecognitionModel & { id: string };
  /** Loads a model's checked bytes and opens it. */
  open: (model: FaceDetectorModel | FaceRecognitionModel) => Promise<TensorSession>;
  detect: DetectOptions;
  minFacePx: number;
  slots: InferenceSlots;
  /** Decode bounds of index images (and tiles) and of search images (selfies). */
  decode: { index: DecodeLimits; search: DecodeLimits };
}

/** YuNet detection and an ArcFace-style recogniser on ONNX Runtime (ADR 0009 section 2). */
export class OnnxFaceEngine implements FaceEngine {
  readonly model: string;
  readonly dimensions: number;
  private sessions: Promise<{ detector: TensorSession; recognizer: TensorSession }> | undefined;

  constructor(private readonly options: OnnxFaceEngineOptions) {
    this.model = options.recognizer.id;
    this.dimensions = options.recognizer.dimensions;
  }

  /**
   * The engine for FaceConfig's self-hosted settings. Models load on first use (`warmUp` loads
   * them now); FACE_MODEL_DIR must be set by then.
   */
  static fromConfig(face: Pick<FaceConfig, 'selfHosted' | 'index' | 'selfie'>): OnnxFaceEngine {
    const config = face.selfHosted;
    const open = async (model: FaceDetectorModel | FaceRecognitionModel) => {
      if (config.modelDir === null) {
        throw new Error('FACE_MODEL_DIR is not set; the self-hosted face provider needs it');
      }
      return openOnnxSession(await readModelFile(config.modelDir, model), {
        threads: config.onnxThreads,
      });
    };
    return new OnnxFaceEngine({
      detector: FACE_DETECTOR_MODELS[config.detectorModel],
      recognizer: { ...FACE_RECOGNITION_MODELS[config.model], id: config.model },
      open,
      // Window-edge drop reuses the tile edge tolerance (FACE_TILE_EDGE_EPSILON): same geometry.
      detect: { ...config.detector, edgeEpsilon: face.index.tileEdgeEpsilon },
      minFacePx: config.minFacePx,
      slots: new InferenceSlots(config.inference.concurrency, config.inference.maxWaitMs),
      decode: {
        // indexPhoto already encoded these at the option's long edge: keep their pixels.
        index: { maxInputPixels: config.decodeMaxPixels },
        search: { longEdge: face.selfie.longEdge, maxInputPixels: config.decodeMaxPixels },
      },
    });
  }

  /** Loads and checks both model files; start-up calls it so a missing file fails fast. */
  async warmUp(): Promise<void> {
    await this.load();
  }

  private load() {
    if (this.sessions === undefined) {
      const { open, detector, recognizer } = this.options;
      this.sessions = Promise.all([open(detector), open(recognizer)]).then(([d, r]) => ({
        detector: d,
        recognizer: r,
      }));
      // A failed load is not remembered: the next call tries again.
      this.sessions.catch(() => (this.sessions = undefined));
    }
    return this.sessions;
  }

  analyze(bytes: Uint8Array, maxFaces: number): Promise<FaceAnalysis> {
    return this.options.slots.run(async () => {
      const { detector, recognizer } = await this.load();
      const image = await decodeRgb(bytes, this.options.decode.index);
      const detections = (
        await detectFaces(detector, this.options.detector, image, this.options.detect)
      ).sort((a, b) => area(b) - area(a));
      const result: FaceAnalysis = { faces: [], unindexed: [] };
      for (const d of detections) {
        const bbox = toRatios(d, image);
        if (d.width < this.options.minFacePx) {
          result.unindexed.push({ bbox, reasons: [SMALL_BOUNDING_BOX] });
        } else if (result.faces.length >= maxFaces) {
          result.unindexed.push({ bbox, reasons: [EXCEEDS_MAX_FACES] });
        } else {
          const crop = alignFace(image, d.landmarks);
          const embedding = await embedFace(recognizer, this.options.recognizer, crop);
          result.faces.push({ bbox, confidence: d.score * 100, embedding });
        }
      }
      return result;
    });
  }

  embedLargest(bytes: Uint8Array): Promise<Float32Array | null> {
    return this.options.slots.run(async () => {
      const { detector, recognizer } = await this.load();
      const image = await decodeRgb(bytes, this.options.decode.search);
      const detections = await detectFaces(
        detector,
        this.options.detector,
        image,
        this.options.detect,
      );
      const largest = detections.reduce<Detection | undefined>(
        (best, d) => (best === undefined || area(d) > area(best) ? d : best),
        undefined,
      );
      if (largest === undefined || largest.width < this.options.minFacePx) return null;
      return embedFace(recognizer, this.options.recognizer, alignFace(image, largest.landmarks));
    });
  }
}
