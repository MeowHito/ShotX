import { afterEach, describe, expect, it, vi } from 'vitest';
import { canUseLiveCamera, isInAppBrowser, isIOS } from './camera';
import type { ClientFaceConfig } from './config';
import { createMediaPipeDetectorLoader } from './detector';
import { evaluateSelfie, type FaceBox, meanLuma, type SelfieGateConfig } from './quality-gate';
import { type CanvasOps, fitLongEdge, processSelfie } from './selfie';

const GATE: SelfieGateConfig = {
  minFaceWidthRatio: 0.18,
  minScore: 0.6,
  minBrightness: 60,
  maxBrightness: 235,
  maxNoseOffsetRatio: 0.35,
};

/** A frontal face: eyes level, nose centred between them. */
function face(extra: Partial<FaceBox> = {}): FaceBox {
  return {
    x: 300,
    y: 200,
    width: 400,
    height: 400,
    score: 0.95,
    keypoints: [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.5, y: 0.5 },
    ],
    ...extra,
  };
}

const measure = (faces: FaceBox[] | null, brightness = 120) => ({
  width: 1000,
  height: 1280,
  faces,
  brightness,
});

describe('selfie quality gate', () => {
  it('accepts exactly one large, frontal, well-lit face', () => {
    expect(evaluateSelfie(measure([face()]), 'front', GATE)).toBeNull();
  });

  it('names the first problem', () => {
    expect(evaluateSelfie(measure([]), 'front', GATE)).toBe('noFace');
    expect(evaluateSelfie(measure([face({ score: 0.3 })]), 'front', GATE)).toBe('noFace');
    expect(evaluateSelfie(measure([face(), face({ x: 0 })]), 'front', GATE)).toBe('multipleFaces');
    expect(evaluateSelfie(measure([face({ width: 100 })]), 'front', GATE)).toBe('tooSmall');
    const turned = face({
      keypoints: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.62, y: 0.5 },
      ],
    });
    expect(evaluateSelfie(measure([turned]), 'front', GATE)).toBe('notFrontal');
    // Side angles are meant to be turned.
    expect(evaluateSelfie(measure([turned]), 'left', GATE)).toBeNull();
    expect(evaluateSelfie(measure([face()], 20), 'front', GATE)).toBe('tooDark');
    expect(evaluateSelfie(measure([face()], 250), 'front', GATE)).toBe('tooBright');
    expect(evaluateSelfie({ ...measure([face()]), width: 0 }, 'front', GATE)).toBe('unreadable');
  });

  it('skips face checks when the detector is unavailable, but still checks light', () => {
    expect(evaluateSelfie(measure(null), 'front', GATE)).toBeNull();
    expect(evaluateSelfie(measure(null, 10), 'front', GATE)).toBe('tooDark');
  });

  it('measures mean luma, optionally inside a box', () => {
    const width = 4;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const bright = i % width >= 2;
      data.set(bright ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    }
    expect(meanLuma({ data, width, height }, { x: 2, y: 0, width: 2, height: 4 })).toBeCloseTo(255);
    expect(meanLuma({ data, width, height }, { x: 0, y: 0, width: 2, height: 4 })).toBe(0);
  });
});

describe('selfie processing (downscale, gate, JPEG)', () => {
  const config: Pick<ClientFaceConfig, 'selfie' | 'gate'> = {
    selfie: { longEdge: 1280, jpegQuality: 90 },
    gate: GATE,
  };

  function fakeCanvas(luma: number, size = { width: 3000, height: 4000 }) {
    const rendered: { width: number; height: number }[] = [];
    const canvas: CanvasOps = {
      decode: vi.fn(() => Promise.resolve({ source: {} as CanvasImageSource, ...size })),
      render: (_source, width, height) => {
        rendered.push({ width, height });
        const data = new Uint8ClampedArray(width * height * 4).fill(luma);
        return {
          surface: {} as CanvasImageSource,
          pixels: { data, width, height },
          toJpeg: vi.fn((quality: number) =>
            Promise.resolve(new Blob([`jpeg@${quality}`], { type: 'image/jpeg' })),
          ),
        };
      },
    };
    return { canvas, rendered };
  }

  it('fits the long edge without upscaling', () => {
    expect(fitLongEdge(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 });
    expect(fitLongEdge(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 });
    expect(fitLongEdge(640, 480, 1280)).toEqual({ width: 640, height: 480 });
  });

  it('downscales to FACE_SELFIE_LONG_EDGE before detecting and encodes JPEG', async () => {
    const { canvas, rendered } = fakeCanvas(128);
    const detect = vi.fn(() => [face({ x: 200, y: 300, width: 400, height: 400 })]);
    const result = await processSelfie(
      { kind: 'file', blob: new Blob(['x'], { type: 'image/heic' }) },
      'front',
      { config, canvas, loadDetector: () => Promise.resolve({ detect }) },
    );
    expect(rendered).toEqual([{ width: 960, height: 1280 }]);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, width: 960, height: 1280 });
    if (result.ok) {
      expect(result.blob.type).toBe('image/jpeg');
      await expect(result.blob.text()).resolves.toBe('jpeg@0.9');
    }
  });

  it('refuses a selfie the gate rejects without encoding it', async () => {
    const { canvas } = fakeCanvas(20);
    const result = await processSelfie(
      { kind: 'frame', source: {} as CanvasImageSource, width: 1280, height: 720 },
      'front',
      { config, canvas, loadDetector: () => Promise.resolve({ detect: () => [face()] }) },
    );
    expect(result).toEqual({ ok: false, issue: 'tooDark' });
  });

  it('reports unreadable files', async () => {
    const { canvas } = fakeCanvas(128);
    canvas.decode = () => Promise.reject(new Error('bad image'));
    const result = await processSelfie({ kind: 'file', blob: new Blob(['x']) }, 'front', {
      config,
      canvas,
      loadDetector: () => Promise.resolve(null),
    });
    expect(result).toEqual({ ok: false, issue: 'unreadable' });
  });
});

const visionMock = vi.hoisted(() => ({
  forVisionTasks: vi.fn((base: string) =>
    Promise.resolve({
      wasmLoaderPath: `${base}/vision_wasm_internal.js`,
      wasmBinaryPath: `${base}/vision_wasm_internal.wasm`,
    }),
  ),
  createFromOptions: vi.fn(),
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: visionMock.forVisionTasks },
  FaceDetector: { createFromOptions: visionMock.createFromOptions },
}));

describe('MediaPipe face detector loader', () => {
  afterEach(() => vi.clearAllMocks());
  const detectorConfig = {
    detector: {
      wasmBasePath: '/mediapipe/dist',
      modelPath: '/mediapipe/blaze_face_short_range.tflite',
    },
    gate: GATE,
  };

  it('loads lazily, once, from the self-hosted paths only', async () => {
    visionMock.createFromOptions.mockResolvedValue({
      detect: () => ({
        detections: [
          {
            boundingBox: { originX: 10, originY: 20, width: 300, height: 320 },
            categories: [{ score: 0.9 }],
            keypoints: [{ x: 0.4, y: 0.4, score: 1 }],
          },
        ],
      }),
    });
    const load = createMediaPipeDetectorLoader(detectorConfig);
    expect(visionMock.forVisionTasks).not.toHaveBeenCalled();
    const detector = await load();
    await load();
    expect(visionMock.forVisionTasks).toHaveBeenCalledTimes(1);
    expect(visionMock.forVisionTasks).toHaveBeenCalledWith('/mediapipe/dist');
    const [fileset, options] = visionMock.createFromOptions.mock.calls[0] as [
      { wasmLoaderPath: string },
      { baseOptions: { modelAssetPath: string } },
    ];
    expect(fileset.wasmLoaderPath).toBe('/mediapipe/dist/vision_wasm_internal.js');
    expect(options.baseOptions.modelAssetPath).toBe('/mediapipe/blaze_face_short_range.tflite');
    for (const path of [fileset.wasmLoaderPath, options.baseOptions.modelAssetPath]) {
      expect(path.startsWith('/')).toBe(true);
      expect(path).not.toMatch(/^\/\/|https?:/);
    }
    expect(detector?.detect({} as CanvasImageSource)).toEqual([
      { x: 10, y: 20, width: 300, height: 320, score: 0.9, keypoints: [{ x: 0.4, y: 0.4 }] },
    ]);
  });

  it('resolves to null when MediaPipe fails to load (the gate degrades)', async () => {
    visionMock.createFromOptions.mockRejectedValue(new Error('model 404'));
    await expect(createMediaPipeDetectorLoader(detectorConfig)()).resolves.toBeNull();
  });
});

describe('camera support', () => {
  it('detects LINE and Facebook in-app browsers', () => {
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari Line/14.10.0',
      ),
    ).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14) [FBAN/EMA;FBLC/th_TH;FBAV/400.0]')).toBe(
      true,
    );
    expect(
      isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari'),
    ).toBe(false);
  });

  it('uses the live camera only outside in-app browsers and with getUserMedia', () => {
    const nav = (userAgent: string, gum = true) =>
      ({
        userAgent,
        mediaDevices: gum ? { getUserMedia: () => Promise.resolve({}) } : undefined,
      }) as unknown as Navigator;
    expect(canUseLiveCamera(nav('Safari'))).toBe(true);
    expect(canUseLiveCamera(nav('Safari Line/14.0'))).toBe(false);
    expect(canUseLiveCamera(nav('Safari', false))).toBe(false);
    expect(canUseLiveCamera(undefined)).toBe(false);
  });

  it('recognizes iPhones and iPadOS', () => {
    expect(isIOS({ userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });
});
