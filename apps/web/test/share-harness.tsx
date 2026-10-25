import { vi } from 'vitest';
import { SharePage } from '@/components/share/share-view';
import { createPublicApiClient } from '@/lib/api/client';
import type { ClientFaceConfig, ClientShareConfig } from '@/lib/face/config';
import type { FaceBox } from '@/lib/face/quality-gate';
import type { CanvasOps } from '@/lib/face/selfie';
import type { FakeApi } from './fake-api';
import { apiClientFor, renderWithProviders } from './render';

export const FACE_CONFIG: ClientFaceConfig = {
  selfie: { longEdge: 1280, jpegQuality: 90 },
  maxSelfies: 3,
  gate: {
    minFaceWidthRatio: 0.18,
    minScore: 0.6,
    minBrightness: 60,
    maxBrightness: 235,
    maxNoseOffsetRatio: 0.35,
  },
  detector: { wasmBasePath: '/mediapipe/dist', modelPath: '/mediapipe/model.tflite' },
};

export const SHARE_CONFIG: ClientShareConfig = {
  zipPollIntervalMs: 1000,
  zipPollTimeoutMs: 60_000,
  maxSelection: 500,
  iosShareMaxFiles: 20,
};

/** A frontal face filling a good part of the frame. */
export function goodFace(): FaceBox {
  return {
    x: 300,
    y: 300,
    width: 500,
    height: 500,
    score: 0.95,
    keypoints: [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.5, y: 0.5 },
    ],
  };
}

/** What the fake camera and MediaPipe see; tests change it between shots. */
export interface FaceScenario {
  faces: FaceBox[];
  luma: number;
  /** null: MediaPipe failed to load. */
  detectorAvailable: boolean;
}

export const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
export const LINE_IN_APP = `${IPHONE_SAFARI} Line/14.10.0`;

export function fakeNavigator(
  options: { userAgent?: string; camera?: 'ok' | 'denied' | 'none'; share?: boolean } = {},
) {
  const stop = vi.fn();
  const getUserMedia = vi.fn(() =>
    options.camera === 'denied'
      ? Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
      : Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
  );
  const share = vi.fn((_data: ShareData) => Promise.resolve());
  const nav = {
    userAgent: options.userAgent ?? IPHONE_SAFARI,
    platform: 'iPhone',
    maxTouchPoints: 5,
    mediaDevices: options.camera === 'none' ? undefined : { getUserMedia },
    ...(options.share
      ? { share, canShare: (data: ShareData) => (data.files?.length ?? 0) > 0 }
      : {}),
  } as unknown as Navigator;
  return { nav, getUserMedia, stop, share };
}

export function renderSharePage(
  fake: FakeApi,
  token: string,
  options: {
    signedIn?: boolean;
    nav?: Navigator;
    scenario?: Partial<FaceScenario>;
    faceConfig?: ClientFaceConfig;
  } = {},
) {
  const scenario: FaceScenario = {
    faces: [goodFace()],
    luma: 128,
    detectorAvailable: true,
    ...options.scenario,
  };
  const canvas: CanvasOps = {
    decode: () => Promise.resolve({ source: {} as CanvasImageSource, width: 3000, height: 4000 }),
    render: (_source, width, height) => ({
      surface: {} as CanvasImageSource,
      pixels: {
        data: new Uint8ClampedArray(width * height * 4).fill(scenario.luma),
        width,
        height,
      },
      toJpeg: () => Promise.resolve(new Blob(['jpeg-bytes'], { type: 'image/jpeg' })),
    }),
  };
  const detect = vi.fn(() => scenario.faces);
  const loadDetector = vi.fn(() => Promise.resolve(scenario.detectorAvailable ? { detect } : null));
  const startDownload = vi.fn();
  const mediaFetch = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(new Blob(['photo'], { type: 'image/jpeg' }))),
  );
  const view = renderWithProviders(
    <SharePage
      token={token}
      initialMeta={null}
      signedIn={options.signedIn ?? false}
      faceConfig={options.faceConfig ?? FACE_CONFIG}
      shareConfig={SHARE_CONFIG}
      testing={{
        publicApi: createPublicApiClient({ fetch: fake.fetch }),
        faceTools: { canvas, loadDetector, navigator: options.nav ?? fakeNavigator().nav },
        runtime: {
          startDownload,
          navigator: () => options.nav,
          fetch: mediaFetch,
          sleep: () => Promise.resolve(),
        },
      }}
    />,
    { api: apiClientFor(fake.fetch) },
  );
  return { ...view, scenario, detect, loadDetector, startDownload, mediaFetch };
}
