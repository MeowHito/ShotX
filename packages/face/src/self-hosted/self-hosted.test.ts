import { FACE_DETECTOR_MODELS, FACE_RECOGNITION_MODELS } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  EXCEEDS_MAX_FACES,
  ImageTooLargeError,
  IndexFacesOutcomeUnknownError,
  NoFaceDetectedError,
  SMALL_BOUNDING_BOX,
} from '../provider';
import { RateLimitedError } from '../throttling';
import { ALIGNED_SIZE, ARCFACE_TEMPLATE, estimateSimilarity, warpSimilarity } from './align';
import { l2Normalize, recognitionInput, similarityFromCosine } from './embed';
import { type FaceEngine, InferenceSlots } from './engine';
import { SelfHostedFaceProvider } from './provider';
import { InMemoryFaceVectorStore } from './vector-store';
import {
  decodeYunet,
  type Detection,
  nonMaximumSuppression,
  windowStarts,
  yunetInput,
} from './yunet';

const yunet = FACE_DETECTOR_MODELS['yunet-2023mar'];
const sface = FACE_RECOGNITION_MODELS['sface-2021dec'];

describe('windowStarts', () => {
  it('is one window when the side fits', () => {
    expect(windowStarts(640, 640, 0.2)).toEqual([0]);
    expect(windowStarts(300, 640, 0.2)).toEqual([0]);
  });

  it('covers the side from 0 to the end with at least the overlap', () => {
    const starts = windowStarts(1920, 640, 0.2);
    expect(starts[0]).toBe(0);
    expect(starts.at(-1)! + 640).toBe(1920);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i - 1]! + 640 - starts[i]!).toBeGreaterThanOrEqual(0.2 * 640);
    }
  });
});

describe('decodeYunet', () => {
  /** Outputs with one confident cell at stride 8, (row 2, col 3). */
  function outputs(score: number) {
    const out: Record<string, Float32Array> = {};
    for (const stride of yunet.strides) {
      const cells = (yunet.inputSize / stride) ** 2;
      out[`cls_${stride}`] = new Float32Array(cells);
      out[`obj_${stride}`] = new Float32Array(cells);
      out[`bbox_${stride}`] = new Float32Array(cells * 4);
      out[`kps_${stride}`] = new Float32Array(cells * 10);
    }
    const idx = 2 * (yunet.inputSize / 8) + 3;
    out.cls_8![idx] = score;
    out.obj_8![idx] = 1.5; // clamped to 1
    out.bbox_8!.set([0.5, 0.5, Math.log(4), Math.log(5)], idx * 4);
    out.kps_8!.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], idx * 10);
    return out;
  }

  it("decodes boxes and landmarks the way OpenCV's FaceDetectorYN does", () => {
    const [face, ...rest] = decodeYunet(outputs(0.81), yunet, 0.8);
    expect(rest).toEqual([]);
    expect(face!.score).toBeCloseTo(0.9, 5); // sqrt(0.81 × 1)
    // centre ((3 + 0.5) × 8, (2 + 0.5) × 8) = (28, 20); size 32 × 40
    const close = (values: readonly number[], expected: number[]) =>
      values.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 4));
    close([face!.left, face!.top, face!.width, face!.height], [12, 0, 32, 40]);
    close(face!.landmarks[0]!, [24, 16]);
    close(face!.landmarks[4]!, [32, 24]);
  });

  it('drops cells below the minimum score', () => {
    expect(decodeYunet(outputs(0.5), yunet, 0.8)).toEqual([]);
  });
});

describe('yunetInput', () => {
  it('writes BGR planes with zero padding', () => {
    const image = { data: Uint8Array.from([10, 20, 30, 40, 50, 60]), width: 2, height: 1 };
    const input = yunetInput(image, { left: 1, top: 0, width: 1, height: 1 }, 2);
    expect(Array.from(input)).toEqual([60, 0, 0, 0, 50, 0, 0, 0, 40, 0, 0, 0]);
  });
});

describe('nonMaximumSuppression', () => {
  const box = (left: number, score: number): Detection => ({
    left,
    top: 0,
    width: 10,
    height: 10,
    landmarks: [],
    score,
  });

  it('keeps the best of overlapping boxes and every separate one', () => {
    const kept = nonMaximumSuppression([box(0, 0.8), box(1, 0.9), box(50, 0.7)], 0.3);
    expect(kept.map((d) => [d.left, d.score])).toEqual([
      [1, 0.9],
      [50, 0.7],
    ]);
  });
});

describe('alignment', () => {
  it('recovers a known similarity transform', () => {
    const t = { a: 0.5 * Math.cos(0.3), b: 0.5 * Math.sin(0.3), tx: 7, ty: -3 };
    const src: [number, number][] = [
      [100, 120],
      [160, 118],
      [130, 150],
      [105, 185],
      [158, 183],
    ];
    const dst = src.map(([x, y]) => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty] as const);
    const estimated = estimateSimilarity(src, dst);
    for (const key of ['a', 'b', 'tx', 'ty'] as const) {
      expect(estimated[key]).toBeCloseTo(t[key], 9);
    }
  });

  it('maps template landmarks to themselves', () => {
    const t = estimateSimilarity(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE);
    expect(t.a).toBeCloseTo(1, 9);
    expect(t.b).toBeCloseTo(0, 9);
  });

  it('copies pixels under the identity and paints outside the image black', () => {
    const size = 4;
    const data = Uint8Array.from({ length: 3 * 3 * 3 }, (_, i) => i + 1);
    const out = warpSimilarity({ data, width: 3, height: 3 }, { a: 1, b: 0, tx: 0, ty: 0 }, size);
    expect(Array.from(out.slice(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(out.slice((1 * size + 2) * 3, (1 * size + 2) * 3 + 3))).toEqual(
      Array.from(data.slice((1 * 3 + 2) * 3, (1 * 3 + 2) * 3 + 3)),
    );
    expect(Array.from(out.slice((3 * size + 3) * 3))).toEqual([0, 0, 0]);
  });
});

describe('recognition input', () => {
  it('feeds RGB planes for SFace', () => {
    const crop = new Uint8Array(ALIGNED_SIZE * ALIGNED_SIZE * 3);
    crop.set([1, 2, 3]);
    const input = recognitionInput(crop, sface);
    const plane = ALIGNED_SIZE * ALIGNED_SIZE;
    expect([input[0], input[plane], input[2 * plane]]).toEqual([1, 2, 3]);
    expect(recognitionInput(crop, { ...sface, channels: 'bgr' })[0]).toBe(3);
  });

  it('normalises embeddings and maps cosine to 0–100', () => {
    const [x, y] = l2Normalize(Float32Array.from([3, 4]));
    expect([x, y].map((v) => Math.round(v! * 1e6) / 1e6)).toEqual([0.6, 0.8]);
    expect(() => l2Normalize(new Float32Array(2))).toThrow(RangeError);
    expect(similarityFromCosine(0.42)).toBeCloseTo(42);
    expect(similarityFromCosine(-0.2)).toBe(0);
    expect(similarityFromCosine(1.0000001)).toBe(100);
  });
});

describe('InferenceSlots', () => {
  it('runs at most `concurrency` at once and refuses callers that would wait too long', async () => {
    vi.useFakeTimers();
    try {
      const slots = new InferenceSlots(1, 100);
      let release!: () => void;
      const first = slots.run(() => new Promise<void>((r) => (release = r)));
      const second = slots.run(() => Promise.resolve('second'));
      const late = expect(second).rejects.toBeInstanceOf(RateLimitedError);
      await vi.advanceTimersByTimeAsync(101);
      await late;
      const third = slots.run(() => Promise.resolve('third'));
      release();
      await first;
      await expect(third).resolves.toBe('third');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A unit vector; the fake engine below finds no face when the image's first byte is 0. */
function unit(...values: number[]): Float32Array {
  return l2Normalize(Float32Array.from(values));
}

function fakeEngine(calls?: { analyze: number }): FaceEngine {
  const box = { left: 0.1, top: 0.1, width: 0.2, height: 0.2 };
  return {
    model: 'sface-2021dec',
    dimensions: 3,
    analyze: (image: Uint8Array) => {
      if (calls) calls.analyze++;
      return Promise.resolve({
        faces:
          image[0] === 0
            ? []
            : [
                { bbox: box, confidence: 99, embedding: unit(1, 0, 0) },
                { bbox: box, confidence: 90, embedding: unit(0.8, 0.6, 0) },
              ],
        unindexed: [{ bbox: box, reasons: [SMALL_BOUNDING_BOX] }],
      });
    },
    embedLargest: (image: Uint8Array) => Promise.resolve(image[0] === 0 ? null : unit(1, 0, 0)),
  };
}

describe('SelfHostedFaceProvider', () => {
  const collectionId = 'pg-owner';
  let counter = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

  it('indexes with fresh ids, reports unindexed faces and searches by 100 × cosine', async () => {
    const store = new InMemoryFaceVectorStore();
    const provider = new SelfHostedFaceProvider({ engine: fakeEngine(), store, newFaceId: ids });
    const first = await provider.indexFaces({
      collectionId,
      image: { bytes: Uint8Array.of(1) },
      externalImageId: 'file-1',
      maxFaces: 100,
      qualityFilter: 'AUTO',
    });
    expect(first.faces).toHaveLength(2);
    expect(first.unindexed[0]!.reasons).toEqual([SMALL_BOUNDING_BOX]);
    // Not idempotent, like IndexFaces: a second call adds new faces.
    await provider.indexFaces({
      collectionId,
      image: { bytes: Uint8Array.of(1) },
      externalImageId: 'file-2',
      maxFaces: 100,
      qualityFilter: 'AUTO',
    });
    expect(store.size).toBe(4);

    const matches = await provider.searchFacesByImage({
      collectionId,
      image: Uint8Array.of(1),
      threshold: 70,
      maxFaces: 10,
      qualityFilter: 'AUTO',
    });
    expect(matches.map((m) => Math.round(m.similarity))).toEqual([100, 100, 80, 80]);
    expect(new Set(matches.map((m) => m.externalImageId))).toEqual(new Set(['file-1', 'file-2']));

    const [seed] = first.faces;
    const expanded = await provider.searchFaces({
      collectionId,
      faceId: seed!.faceId,
      threshold: 90,
      maxFaces: 10,
    });
    expect(expanded.map((m) => m.faceId)).not.toContain(seed!.faceId);
    expect(expanded).toHaveLength(1);
    // Another collection sees nothing.
    expect(
      await provider.searchFaces({
        collectionId: 'pg-other',
        faceId: seed!.faceId,
        threshold: 0,
        maxFaces: 10,
      }),
    ).toEqual([]);
  });

  it('throws NoFaceDetectedError for a search image without a face', async () => {
    const provider = new SelfHostedFaceProvider({
      engine: fakeEngine(),
      store: new InMemoryFaceVectorStore(),
    });
    await expect(
      provider.searchFacesByImage({
        collectionId,
        image: Uint8Array.of(0),
        threshold: 0,
        maxFaces: 10,
        qualityFilter: 'AUTO',
      }),
    ).rejects.toBeInstanceOf(NoFaceDetectedError);
  });

  it('reports a failed insert as an unknown outcome and refuses oversized images first', async () => {
    const store = new InMemoryFaceVectorStore();
    vi.spyOn(store, 'insert').mockRejectedValue(new Error('connection terminated'));
    const calls = { analyze: 0 };
    const provider = new SelfHostedFaceProvider({
      engine: fakeEngine(calls),
      store,
      maxImageBytes: 2,
    });
    const request = {
      collectionId,
      image: { bytes: Uint8Array.of(1) },
      externalImageId: 'file-1',
      maxFaces: 100,
      qualityFilter: 'AUTO' as const,
    };
    await expect(provider.indexFaces(request)).rejects.toBeInstanceOf(
      IndexFacesOutcomeUnknownError,
    );
    await expect(
      provider.indexFaces({ ...request, image: { bytes: Uint8Array.of(1, 1, 1) } }),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(calls.analyze).toBe(1);
  });

  it('lists, deletes (ignoring unknown ids) and drops collections', async () => {
    const store = new InMemoryFaceVectorStore();
    const provider = new SelfHostedFaceProvider({ engine: fakeEngine(), store, newFaceId: ids });
    const { faces } = await provider.indexFaces({
      collectionId,
      image: { bytes: Uint8Array.of(1) },
      externalImageId: 'file-1',
      maxFaces: 100,
      qualityFilter: 'AUTO',
    });
    const page = await provider.listFaces({ collectionId, maxResults: 1 });
    expect(page.faces).toHaveLength(1);
    const rest = await provider.listFaces({
      collectionId,
      maxResults: 1,
      nextToken: page.nextToken,
    });
    expect(rest.faces).toHaveLength(1);
    expect(rest.faces[0]!.faceId).not.toBe(page.faces[0]!.faceId);
    await provider.deleteFaces(collectionId, [faces[0]!.faceId, 'missing']);
    expect(store.size).toBe(1);
    expect(await provider.createCollection()).toEqual({ faceModelVersion: 'sface-2021dec' });
    await provider.deleteCollection(collectionId);
    expect(store.size).toBe(0);
  });

  it('exposes the reason names that signal tiling reads', () => {
    expect([SMALL_BOUNDING_BOX, EXCEEDS_MAX_FACES]).toEqual([
      'SMALL_BOUNDING_BOX',
      'EXCEEDS_MAX_FACES',
    ]);
  });
});
