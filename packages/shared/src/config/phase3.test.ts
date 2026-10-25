import { describe, expect, it } from 'vitest';
import { loadApiLimitsConfig } from './api';
import {
  CONSENT_POLICY_VERSIONS,
  LATEST_CONSENT_POLICY_VERSION,
  loadConsentConfig,
} from './consent';
import { loadFeatureFlags } from './features';
import { loadWorkerSettings } from './worker';

describe('loadApiLimitsConfig', () => {
  it('uses the defaults the api had hard-coded', () => {
    expect(loadApiLimitsConfig({})).toEqual({
      jsonBodyMaxBytes: 64 * 1024,
      completeBodyMaxBytes: 1024 * 1024,
      uploadInitRate: { limit: 600, windowSeconds: 60 },
    });
  });

  it('reads overrides and keeps the JSON limit within the complete limit', () => {
    expect(
      loadApiLimitsConfig({
        API_JSON_BODY_MAX_BYTES: '131072',
        UPLOAD_COMPLETE_BODY_MAX_BYTES: '2097152',
        UPLOAD_INIT_RATE_PER_USER: '100',
        UPLOAD_INIT_RATE_WINDOW_SECONDS: '10',
      }),
    ).toEqual({
      jsonBodyMaxBytes: 131_072,
      completeBodyMaxBytes: 2_097_152,
      uploadInitRate: { limit: 100, windowSeconds: 10 },
    });
    expect(() => loadApiLimitsConfig({ API_JSON_BODY_MAX_BYTES: String(4 * 1024 * 1024) })).toThrow(
      /API_JSON_BODY_MAX_BYTES must be less than or equal to UPLOAD_COMPLETE_BODY_MAX_BYTES/,
    );
    expect(() => loadApiLimitsConfig({ UPLOAD_INIT_RATE_PER_USER: '0' })).toThrow(
      /at UPLOAD_INIT_RATE_PER_USER\b/,
    );
  });
});

describe('loadWorkerSettings', () => {
  it('has the defaults the worker had, plus faces and zip consumers', () => {
    expect(loadWorkerSettings({})).toEqual({
      consumers: {
        media: { batchSize: 4, concurrency: 2 },
        faces: { batchSize: 4, concurrency: 2 },
        zip: { batchSize: 1, concurrency: 1 },
        jobs: { batchSize: 1, concurrency: 1 },
      },
      receiveWaitSeconds: 20,
      retryBaseSeconds: 10,
      shutdownGraceMs: 20_000,
      maxProcessingMs: {
        media: 4 * 3_600_000,
        faces: 2 * 3_600_000,
        zip: 2 * 3_600_000,
        jobs: 6 * 3_600_000,
      },
      jobBatchSize: 200,
      jobDedupeTtlSeconds: 7 * 86_400,
      exifDefaultUtcOffset: '+07:00',
      video: {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        x264Preset: 'veryfast',
        audioBitrateKbps: 128,
      },
      tmpDir: undefined,
      logLevel: 'info',
    });
  });

  it('reads overrides', () => {
    const s = loadWorkerSettings({
      WORKER_FACES_BATCH_SIZE: '10',
      WORKER_FACES_CONCURRENCY: '5',
      WORKER_ZIP_MAX_PROCESSING_SECONDS: '600',
      WORKER_EXIF_DEFAULT_UTC_OFFSET: '-03:30',
      WORKER_VIDEO_X264_PRESET: 'fast',
      WORKER_TMP_DIR: '/scratch',
      LOG_LEVEL: 'debug',
    });
    expect(s.consumers.faces).toEqual({ batchSize: 10, concurrency: 5 });
    expect(s.maxProcessingMs.zip).toBe(600_000);
    expect(s.exifDefaultUtcOffset).toBe('-03:30');
    expect(s.video.x264Preset).toBe('fast');
    expect(s.tmpDir).toBe('/scratch');
    expect(s.logLevel).toBe('debug');
  });

  it.each(['MEDIA', 'FACES', 'ZIP', 'JOBS'])('keeps %s concurrency within its batch size', (q) => {
    expect(() =>
      loadWorkerSettings({ [`WORKER_${q}_BATCH_SIZE`]: '2', [`WORKER_${q}_CONCURRENCY`]: '3' }),
    ).toThrow(new RegExp(`WORKER_${q}_CONCURRENCY must be at most WORKER_${q}_BATCH_SIZE`));
  });

  it.each([
    ['WORKER_MEDIA_BATCH_SIZE', '11'],
    ['WORKER_RECEIVE_WAIT_SECONDS', '21'],
    ['WORKER_SHUTDOWN_GRACE_SECONDS', '111'],
    ['WORKER_FACES_MAX_PROCESSING_SECONDS', '59'],
    ['WORKER_JOB_DEDUPE_TTL_SECONDS', '60'],
    ['WORKER_EXIF_DEFAULT_UTC_OFFSET', '07:00'],
    ['WORKER_VIDEO_X264_PRESET', 'placebo'],
    ['LOG_LEVEL', 'trace'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadWorkerSettings({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadFeatureFlags', () => {
  it('keeps face search off unless explicitly enabled', () => {
    expect(loadFeatureFlags({})).toEqual({ faceSearch: false });
    expect(loadFeatureFlags({ FACE_SEARCH_ENABLED: '' })).toEqual({ faceSearch: false });
    expect(loadFeatureFlags({ FACE_SEARCH_ENABLED: 'false' })).toEqual({ faceSearch: false });
    expect(loadFeatureFlags({ FACE_SEARCH_ENABLED: 'true' })).toEqual({ faceSearch: true });
    expect(() => loadFeatureFlags({ FACE_SEARCH_ENABLED: 'maybe' })).toThrow(
      /at FACE_SEARCH_ENABLED\b/,
    );
  });
});

describe('loadConsentConfig', () => {
  const secret = 's'.repeat(32);

  it('defaults to the latest known policy version and requires the IP hash secret', () => {
    expect(LATEST_CONSENT_POLICY_VERSION).toBe(CONSENT_POLICY_VERSIONS.at(-1));
    expect(loadConsentConfig({ IP_HASH_SECRET: secret })).toEqual({
      policyVersion: LATEST_CONSENT_POLICY_VERSION,
      ipHashSecret: secret,
    });
    expect(() => loadConsentConfig({})).toThrow(/at IP_HASH_SECRET\b/);
  });

  it('accepts only versions that have a text, and never prints the secret', () => {
    expect(() =>
      loadConsentConfig({ IP_HASH_SECRET: secret, CONSENT_POLICY_VERSION: '2099-01-01' }),
    ).toThrow(/at CONSENT_POLICY_VERSION\b/);
    let message = '';
    try {
      loadConsentConfig({ IP_HASH_SECRET: 'short-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/at IP_HASH_SECRET\b/);
    expect(message).not.toContain('short-secret-value');
  });
});
