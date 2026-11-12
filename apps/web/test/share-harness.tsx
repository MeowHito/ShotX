import type { Locale } from '@/i18n/config';
import type { ViewerLoginOptions } from '@/lib/auth/viewer-login';
import { TURNSTILE_SCRIPT_URL } from '@shotx/shared';
import { vi } from 'vitest';
import { FaceDeletionPage } from '@/components/share/face-deletion-page';
import { SharePage } from '@/components/share/share-view';
import { createPublicApiClient } from '@/lib/api/client';
import type { ClientFaceConfig, ClientShareConfig } from '@/lib/face/config';
import type { FaceBox } from '@/lib/face/quality-gate';
import type { CanvasOps } from '@/lib/face/selfie';
import type { TurnstileLoader } from '@/lib/captcha/turnstile';
import type { FakeApi } from './fake-api';
import { apiClientFor, renderWithProviders } from './render';

export const FACE_CONFIG: ClientFaceConfig = {
  gate: {
    minFaceWidthRatio: 0.18,
    minScore: 0.6,
    minBrightness: 60,
    maxBrightness: 235,
    maxNoseOffsetRatio: 0.35,
  },
  detector: { wasmBasePath: '/mediapipe/dist', modelPath: '/mediapipe/model.tflite' },
  cameraZoom: 1.4,
  captcha: { provider: 'none' },
};

/** CAPTCHA_PROVIDER=turnstile with Cloudflare's always-passes test site key. */
export const TURNSTILE_FACE_CONFIG: ClientFaceConfig = {
  ...FACE_CONFIG,
  captcha: {
    provider: 'turnstile',
    siteKey: '1x00000000000000000000AA',
    scriptUrl: TURNSTILE_SCRIPT_URL,
  },
};

export const SHARE_CONFIG: ClientShareConfig = {
  zipPollIntervalMs: 1000,
  zipPollTimeoutMs: 60_000,
  iosShareMaxFiles: 20,
  photoPrefetchConcurrency: 3,
  downloadGapMs: 0,
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

/** Fake canvas and MediaPipe driven by a scenario, with spies on what the scan flow asks. */
function faceHarness(partial: Partial<FaceScenario> | undefined) {
  const scenario: FaceScenario = {
    faces: [goodFace()],
    luma: 128,
    detectorAvailable: true,
    ...partial,
  };
  const rendered: { width: number; height: number }[] = [];
  const toJpeg = vi.fn((_quality: number) =>
    Promise.resolve(new Blob(['jpeg-bytes'], { type: 'image/jpeg' })),
  );
  const canvas: CanvasOps = {
    decode: () => Promise.resolve({ source: {} as CanvasImageSource, width: 3000, height: 4000 }),
    render: (_source, width, height) => {
      rendered.push({ width, height });
      return {
        surface: {} as CanvasImageSource,
        pixels: {
          data: new Uint8ClampedArray(width * height * 4).fill(scenario.luma),
          width,
          height,
        },
        toJpeg,
      };
    },
  };
  const detect = vi.fn(() => scenario.faces);
  const loadDetector = vi.fn(() => Promise.resolve(scenario.detectorAvailable ? { detect } : null));
  return { scenario, canvas, detect, loadDetector, rendered, toJpeg };
}

/** The "ขอลบใบหน้าของฉัน" page against the fake API. */
export function renderFaceDeletionPage(
  fake: FakeApi,
  token: string,
  options: {
    nav?: Navigator;
    scenario?: Partial<FaceScenario>;
    faceConfig?: ClientFaceConfig;
    loadTurnstile?: TurnstileLoader;
  } = {},
) {
  const face = faceHarness(options.scenario);
  const onClose = vi.fn();
  const view = renderWithProviders(
    <FaceDeletionPage
      token={token}
      signedIn={false}
      faceConfig={options.faceConfig ?? FACE_CONFIG}
      testing={{
        publicApi: createPublicApiClient({ fetch: fake.fetch }),
        faceTools: {
          canvas: face.canvas,
          loadDetector: face.loadDetector,
          navigator: options.nav ?? fakeNavigator().nav,
          ...(options.loadTurnstile !== undefined ? { loadTurnstile: options.loadTurnstile } : {}),
        },
        onClose,
      }}
    />,
    { api: apiClientFor(fake.fetch) },
  );
  return { ...view, ...face, onClose };
}

export function renderSharePage(
  fake: FakeApi,
  token: string,
  options: {
    signedIn?: boolean;
    nav?: Navigator;
    scenario?: Partial<FaceScenario>;
    faceConfig?: ClientFaceConfig;
    loadTurnstile?: TurnstileLoader;
    viewerLogin?: ViewerLoginOptions;
    locale?: Locale;
  } = {},
) {
  const { scenario, canvas, detect, loadDetector, rendered, toJpeg } = faceHarness(
    options.scenario,
  );
  const startDownload = vi.fn();
  const mediaFetch = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(new Blob(['photo'], { type: 'image/jpeg' }))),
  );
  const view = renderWithProviders(
    <SharePage
      shareRef={token}
      initialMeta={null}
      signedIn={options.signedIn ?? false}
      viewerLogin={options.viewerLogin}
      faceConfig={options.faceConfig ?? FACE_CONFIG}
      shareConfig={SHARE_CONFIG}
      testing={{
        publicApi: createPublicApiClient({ fetch: fake.fetch }),
        faceTools: {
          canvas,
          loadDetector,
          navigator: options.nav ?? fakeNavigator().nav,
          ...(options.loadTurnstile !== undefined ? { loadTurnstile: options.loadTurnstile } : {}),
        },
        runtime: {
          startDownload,
          navigator: () => options.nav,
          fetch: mediaFetch,
          sleep: () => Promise.resolve(),
        },
      }}
    />,
    { api: apiClientFor(fake.fetch), locale: options.locale },
  );
  return { ...view, scenario, detect, loadDetector, startDownload, mediaFetch, rendered, toJpeg };
}
