import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FACE_DETECTOR_MODELS,
  FACE_RECOGNITION_MODELS,
  type FaceDetectorModel,
  loadFaceConfig,
} from '@shotx/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_DIR } from '../cli/download-models';
import { UnreadableImageError } from '../image';
import { decodeRgb } from './raster';
import { EXCEEDS_MAX_FACES, SMALL_BOUNDING_BOX } from '../provider';
import { InferenceSlots, OnnxFaceEngine } from './engine';
import {
  ModelChecksumError,
  ModelFileMissingError,
  readModelFile,
  type TensorSession,
} from './session';

const yunet = FACE_DETECTOR_MODELS['yunet-2023mar'];
const sface = FACE_RECOGNITION_MODELS['sface-2021dec'];

/** A YuNet stand-in that reports faces of the given widths (stride-8 cells along row 4). */
function fakeDetector(widths: number[]): TensorSession {
  return {
    run() {
      const out: Record<string, Float32Array> = {};
      for (const stride of yunet.strides) {
        const cells = (yunet.inputSize / stride) ** 2;
        out[`cls_${stride}`] = new Float32Array(cells);
        out[`obj_${stride}`] = new Float32Array(cells);
        out[`bbox_${stride}`] = new Float32Array(cells * 4);
        out[`kps_${stride}`] = new Float32Array(cells * 10);
      }
      widths.forEach((width, i) => {
        const idx = 4 * (yunet.inputSize / 8) + 1 + i * 12; // far apart: no NMS overlap
        out.cls_8![idx] = 0.95;
        out.obj_8![idx] = 0.95;
        out.bbox_8!.set([0, 0, Math.log(width / 8), Math.log(width / 8)], idx * 4);
        out.kps_8!.set([-0.3, -0.3, 0.3, -0.3, 0, 0, -0.2, 0.3, 0.2, 0.3], idx * 10);
      });
      return Promise.resolve(out);
    },
  };
}

const fakeRecognizer: TensorSession = {
  run: () => Promise.resolve({ fc1: Float32Array.from({ length: 128 }, (_, i) => i + 1) }),
};

async function grey(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer();
}

function engineWith(widths: number[], minFacePx = 32) {
  return new OnnxFaceEngine({
    detector: yunet,
    recognizer: { ...sface, id: 'sface-2021dec' },
    open: (model) =>
      Promise.resolve(
        (model as FaceDetectorModel).kind === 'yunet' ? fakeDetector(widths) : fakeRecognizer,
      ),
    detect: { minScore: 0.8, nmsIou: 0.3, longEdge: 640, windowOverlap: 0.2, edgeEpsilon: 0.01 },
    minFacePx,
    slots: new InferenceSlots(2, 1000),
    decode: {
      index: { maxInputPixels: 40_000_000 },
      search: { longEdge: 1280, maxInputPixels: 40_000_000 },
    },
  });
}

describe('OnnxFaceEngine (fake sessions)', () => {
  it('embeds the largest faces, skipping small and surplus ones with Rekognition reasons', async () => {
    const engine = engineWith([40, 20, 60, 50]);
    const result = await engine.analyze(await grey(640, 480), 2);
    expect(result.faces).toHaveLength(2);
    // Largest first: 60 and 50 px are embedded, 40 px is beyond maxFaces, 20 px is too small.
    expect(result.faces[0]!.bbox.width).toBeCloseTo(60 / 640, 5);
    expect(result.faces[1]!.bbox.width).toBeCloseTo(50 / 640, 5);
    expect(result.unindexed.map((u) => u.reasons)).toEqual([
      [EXCEEDS_MAX_FACES],
      [SMALL_BOUNDING_BOX],
    ]);
    expect(result.faces[0]!.confidence).toBeCloseTo(95, 3);
    const norm = Math.hypot(...result.faces[0]!.embedding);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('searches with the largest face, or none when it is too small', async () => {
    expect(await engineWith([60, 40]).embedLargest(await grey(640, 480))).toHaveLength(128);
    expect(await engineWith([20]).embedLargest(await grey(640, 480))).toBeNull();
    expect(await engineWith([]).embedLargest(await grey(640, 480))).toBeNull();
  });
});

describe('decoding limits (anonymous selfies)', () => {
  it('refuses a huge flat image from its header and shrinks a big selfie while loading', async () => {
    // A 9000 × 9000 flat PNG is tiny on the wire but 243 MB as RGB.
    const huge = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    await expect(
      decodeRgb(huge, { longEdge: 1280, maxInputPixels: 40_000_000 }),
    ).rejects.toBeInstanceOf(UnreadableImageError);
    const big = await grey(4000, 3000);
    const decoded = await decodeRgb(big, { longEdge: 1280, maxInputPixels: 40_000_000 });
    expect([decoded.width, decoded.height]).toEqual([1280, 960]);
    expect(decoded.data.length).toBe(1280 * 960 * 3);
  });

  it('refuses the oversized selfie in embedLargest before any inference', async () => {
    const huge = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    await expect(engineWith([60]).embedLargest(huge)).rejects.toBeInstanceOf(UnreadableImageError);
  });
});

describe('model files', () => {
  it('refuses a file whose SHA-256 differs from the registry, and names a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'face-models-'));
    try {
      await writeFile(join(dir, yunet.file), 'not a model');
      await expect(readModelFile(dir, yunet)).rejects.toBeInstanceOf(ModelChecksumError);
      await expect(readModelFile(dir, sface)).rejects.toBeInstanceOf(ModelFileMissingError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly without FACE_MODEL_DIR', async () => {
    const engine = OnnxFaceEngine.fromConfig(loadFaceConfig({}));
    await expect(engine.warmUp()).rejects.toThrow(/FACE_MODEL_DIR is not set/);
  });
});

const modelDir = process.env.FACE_MODEL_DIR ?? DEFAULT_MODEL_DIR;
const haveModels = existsSync(join(modelDir, yunet.file)) && existsSync(join(modelDir, sface.file));

describe.skipIf(!haveModels)('OnnxFaceEngine (real models; `pnpm face-models` first)', () => {
  it('loads both checked models and finds no face in a flat image', async () => {
    const config = loadFaceConfig({ FACE_MODEL_DIR: modelDir }).selfHosted;
    const engine = OnnxFaceEngine.fromConfig({ ...loadFaceConfig({}), selfHosted: config });
    await engine.warmUp();
    // Set before ONNX Runtime loaded: no usage telemetry leaves the machine (ADR 0009).
    expect(process.env.ORT_DISABLE_TELEMETRY).toBe('1');
    expect(await engine.analyze(await grey(1600, 1000), 100)).toEqual({ faces: [], unindexed: [] });
    expect(await engine.embedLargest(await grey(800, 600))).toBeNull();
  });
});
