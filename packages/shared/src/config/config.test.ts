import { describe, expect, expectTypeOf, it } from 'vitest';
import { loadCostConfig } from './cost';
import * as shared from '../index';
import { loadFaceConfig, loadFaceSearchUploadConfig, TILING_MODES, type TilingMode } from './face';

describe('loadFaceConfig', () => {
  it('uses the spec defaults', () => {
    const config = loadFaceConfig({ FACE_PROVIDER: 'rekognition' });
    expect(config.provider).toBe('rekognition');
    expect(config.thresholds).toEqual({ strong: 95, maybe: 85 });
    expect(config.search).toMatchObject({ maxSelfies: 3, expansionSeeds: 2 });
    expect(config.index).toMatchObject({ longEdge: 3500, jpegQuality: 90, maxFaces: 100 });
    expect(config.index.qualityFilter).toBe('LOW');
    expect(config.index.tileEdgeEpsilon).toBe(0.01);
    expect(config.rekognition.region).toBe('ap-southeast-1');
    expect(config.deletion).toEqual({
      threshold: 95,
      alert: { perShare: 20, windowSeconds: 86_400 },
    });
  });

  it("defaults to the self-hosted provider with the selected model's starting thresholds", () => {
    const config = loadFaceConfig({});
    expect(config.provider).toBe('self-hosted');
    expect(config.thresholds).toEqual({ strong: 50, maybe: 36 });
    expect(config.deletion.threshold).toBe(50);
    expect(config.selfHosted).toEqual({
      detectorModel: 'yunet-2023mar',
      model: 'sface-2021dec',
      modelDir: null,
      detector: { minScore: 0.8, nmsIou: 0.3, longEdge: 1920, windowOverlap: 0.2 },
      minFacePx: 32,
      onnxThreads: 2,
      inference: { concurrency: 2, maxWaitMs: 5000 },
      hnsw: { efSearch: 100, maxScanTuples: 20_000 },
      decodeMaxPixels: 40_000_000,
    });
  });

  it('reads the self-hosted settings and checks thresholds after the defaults apply', () => {
    const config = loadFaceConfig({
      FACE_MODEL_DIR: '/models',
      FACE_DETECTOR_LONG_EDGE: '1280',
      FACE_INFERENCE_CONCURRENCY: '4',
      FACE_HNSW_EF_SEARCH: '200',
      FACE_STRONG: '60',
    });
    expect(config.selfHosted.modelDir).toBe('/models');
    expect(config.selfHosted.detector.longEdge).toBe(1280);
    expect(config.selfHosted.inference.concurrency).toBe(4);
    expect(config.selfHosted.hnsw.efSearch).toBe(200);
    expect(config.thresholds).toEqual({ strong: 60, maybe: 36 });
    // The deletion threshold follows FACE_STRONG unless it is set.
    expect(loadFaceConfig({ FACE_STRONG: '97', FACE_MAYBE: '80' }).deletion.threshold).toBe(97);
    expect(() => loadFaceConfig({ FACE_MAYBE: '55' })).toThrow(
      /FACE_STRONG must be greater than or equal to FACE_MAYBE/,
    );
    expect(() => loadFaceConfig({ FACE_MODEL: 'buffalo_l' })).toThrow(/Invalid face configuration/);
    expect(() => loadFaceConfig({ FACE_PROVIDER: 'aws' })).toThrow(/Invalid face configuration/);
  });

  it('reads the deletion threshold and keeps it at or above FACE_MAYBE', () => {
    const rekognition = { FACE_PROVIDER: 'rekognition' };
    expect(
      loadFaceConfig({ ...rekognition, FACE_DELETION_THRESHOLD: '90' }).deletion.threshold,
    ).toBe(90);
    expect(() => loadFaceConfig({ ...rekognition, FACE_DELETION_THRESHOLD: '80' })).toThrow(
      /FACE_DELETION_THRESHOLD must be greater than or equal to FACE_MAYBE/,
    );
  });

  it('uses the default encode settings', () => {
    expect(loadFaceConfig({}).encode).toEqual({
      qualityStep: 5,
      minQuality: 60,
      shrinkFactor: 0.85,
      minLongEdge: 320,
    });
  });

  it('uses the default rekognition rate limits and call profiles', () => {
    expect(loadFaceConfig({}).rekognition).toEqual({
      region: 'ap-southeast-1',
      rateLimit: {
        keyPrefix: 'shotx:rekognition',
        burstSeconds: 1,
        tps: {
          indexFaces: 5,
          searchFacesByImage: 5,
          searchFaces: 5,
          deleteFaces: 5,
          listFaces: 5,
          collection: 5,
        },
      },
      requestTimeoutMs: 10_000,
      background: { maxAttempts: 8, retryBaseMs: 200, retryMaxMs: 10_000, maxWaitMs: 30_000 },
      interactive: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000, maxWaitMs: 2000 },
    });
  });

  it('reads overrides from the environment', () => {
    const config = loadFaceConfig({ FACE_STRONG: '97', FACE_MAYBE: '80', FACE_TILE_GRID: '3' });
    expect(config.thresholds).toEqual({ strong: 97, maybe: 80 });
    expect(config.index.tileGrid).toBe(3);
  });

  it('reads the rate limit, call profile, tiling and encode keys from the environment', () => {
    const config = loadFaceConfig({
      FACE_REKOGNITION_TPS_SEARCH_FACES_BY_IMAGE: '50',
      FACE_REKOGNITION_TPS_COLLECTION: '1',
      FACE_REKOGNITION_TPS_LIST_FACES: '2',
      FACE_REKOGNITION_BURST_SECONDS: '0.25',
      FACE_REKOGNITION_REQUEST_TIMEOUT_MS: '15000',
      FACE_REKOGNITION_RATE_LIMIT_PREFIX: 'shotx-staging:rekognition.v2',
      FACE_REKOGNITION_INTERACTIVE_MAX_WAIT_MS: '500',
      FACE_REKOGNITION_INTERACTIVE_MAX_ATTEMPTS: '2',
      FACE_TILE_EDGE_EPSILON: '0.02',
      FACE_ENCODE_SHRINK_FACTOR: '0.7',
      FACE_ENCODE_MIN_LONG_EDGE: '640',
    });
    expect(config.rekognition.rateLimit).toEqual({
      keyPrefix: 'shotx-staging:rekognition.v2',
      burstSeconds: 0.25,
      tps: {
        indexFaces: 5,
        searchFacesByImage: 50,
        searchFaces: 5,
        deleteFaces: 5,
        listFaces: 2,
        collection: 1,
      },
    });
    expect(config.rekognition.requestTimeoutMs).toBe(15_000);
    expect(config.rekognition.interactive).toMatchObject({ maxWaitMs: 500, maxAttempts: 2 });
    expect(config.index.tileEdgeEpsilon).toBe(0.02);
    expect(config.encode).toMatchObject({ shrinkFactor: 0.7, minLongEdge: 640 });
  });

  it('maps the existing retry keys to the background profile', () => {
    const { background, interactive } = loadFaceConfig({
      FACE_REKOGNITION_MAX_ATTEMPTS: '4',
      FACE_REKOGNITION_RETRY_BASE_MS: '50',
      FACE_REKOGNITION_RETRY_MAX_MS: '5000',
      FACE_REKOGNITION_MAX_WAIT_MS: '0',
    }).rekognition;
    expect(background).toEqual({ maxAttempts: 4, retryBaseMs: 50, retryMaxMs: 5000, maxWaitMs: 0 });
    expect(interactive).toEqual({
      maxAttempts: 3,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      maxWaitMs: 2000,
    });
  });

  it('no longer has a single rekognition.tps', () => {
    const { rekognition } = loadFaceConfig({ FACE_REKOGNITION_TPS: '50' });
    expect(rekognition).not.toHaveProperty('tps');
    expect(Object.values(rekognition.rateLimit.tps)).toEqual([5, 5, 5, 5, 5, 5]);
    expectTypeOf(rekognition).not.toHaveProperty('tps');
  });

  it('defaults FACE_INDEX_TILING to signal and accepts every tiling mode', () => {
    expect(loadFaceConfig({}).index.tiling).toBe('signal');
    for (const mode of TILING_MODES) {
      expect(loadFaceConfig({ FACE_INDEX_TILING: mode }).index.tiling).toBe(mode);
    }
    expect(TILING_MODES).toEqual(['never', 'signal', 'always']);
    // The only definition: packages/face re-exports it from the package root.
    expect(shared.TILING_MODES).toBe(TILING_MODES);
    expectTypeOf<shared.TilingMode>().toEqualTypeOf<TilingMode>();
    expectTypeOf<TilingMode>().toEqualTypeOf<'never' | 'signal' | 'always'>();
    expect(() => loadFaceConfig({ FACE_INDEX_TILING: 'sometimes' })).toThrow(
      /at FACE_INDEX_TILING\b/,
    );
  });

  it('accepts every TPS from 1 to 1000 and a burst in (0, 1]', () => {
    const keys = [
      'FACE_REKOGNITION_TPS_INDEX_FACES',
      'FACE_REKOGNITION_TPS_SEARCH_FACES_BY_IMAGE',
      'FACE_REKOGNITION_TPS_SEARCH_FACES',
      'FACE_REKOGNITION_TPS_DELETE_FACES',
      'FACE_REKOGNITION_TPS_LIST_FACES',
      'FACE_REKOGNITION_TPS_COLLECTION',
    ];
    for (const value of ['1', '1000']) {
      const { tps } = loadFaceConfig(Object.fromEntries(keys.map((k) => [k, value]))).rekognition
        .rateLimit;
      expect(Object.values(tps)).toEqual(Array(keys.length).fill(Number(value)));
    }
    for (const burst of ['0.001', '0.5', '1']) {
      expect(
        loadFaceConfig({ FACE_REKOGNITION_BURST_SECONDS: burst }).rekognition.rateLimit
          .burstSeconds,
      ).toBe(Number(burst));
    }
  });

  it('defaults the orphan grace period to 3 hours and accepts 1 minute to 24 hours', () => {
    expect(loadFaceConfig({}).index.orphanGraceMs).toBe(10_800_000);
    // At least 2 × infra's 3960 s worst-case faces job.
    expect(loadFaceConfig({}).index.orphanGraceMs).toBeGreaterThanOrEqual(2 * 3960 * 1000);
    for (const ms of ['60000', '86400000']) {
      expect(loadFaceConfig({ FACE_ORPHAN_GRACE_MS: ms }).index.orphanGraceMs).toBe(Number(ms));
    }
  });

  it('defaults the Rekognition request timeout to 10 s', () => {
    expect(loadFaceConfig({}).rekognition.requestTimeoutMs).toBe(10_000);
    for (const ms of ['1000', '120000']) {
      expect(
        loadFaceConfig({ FACE_REKOGNITION_REQUEST_TIMEOUT_MS: ms }).rekognition.requestTimeoutMs,
      ).toBe(Number(ms));
    }
  });

  it('defaults the face-search request limits to 10 per IP per 10 minutes', () => {
    expect(loadFaceConfig({}).searchRateLimits).toEqual({
      perIp: { limit: 10, windowSeconds: 600 },
      perShare: { limit: 1200, windowSeconds: 600 },
      perViewer: { limit: 10, windowSeconds: 600 },
    });
  });

  it('reads the face-search request limits from the environment', () => {
    const { searchRateLimits } = loadFaceConfig({
      FACE_SEARCH_RATE_PER_IP: '30',
      FACE_SEARCH_RATE_PER_IP_WINDOW_SECONDS: '300',
      FACE_SEARCH_RATE_PER_SHARE: '5000',
      FACE_SEARCH_RATE_PER_SHARE_WINDOW_SECONDS: '60',
      FACE_SEARCH_RATE_PER_VIEWER: '3',
      FACE_SEARCH_RATE_PER_VIEWER_WINDOW_SECONDS: '3600',
    });
    expect(searchRateLimits).toEqual({
      perIp: { limit: 30, windowSeconds: 300 },
      perShare: { limit: 5000, windowSeconds: 60 },
      perViewer: { limit: 3, windowSeconds: 3600 },
    });
  });

  it('treats empty variables as unset', () => {
    expect(
      loadFaceConfig({ FACE_PROVIDER: 'rekognition', FACE_STRONG: '' }).thresholds.strong,
    ).toBe(95);
    expect(loadFaceConfig({ FACE_STRONG: '', FACE_MODEL_DIR: '' }).selfHosted.modelDir).toBeNull();
    expect(
      loadFaceConfig({ FACE_REKOGNITION_RATE_LIMIT_PREFIX: '' }).rekognition.rateLimit,
    ).toMatchObject({ keyPrefix: 'shotx:rekognition' });
  });

  it('keeps the decode pixel limit above the index image size', () => {
    expect(() => loadFaceConfig({ FACE_DECODE_MAX_PIXELS: '10000000' })).toThrow(
      /FACE_DECODE_MAX_PIXELS must be at least FACE_INDEX_LONG_EDGE²/,
    );
    expect(() =>
      loadFaceConfig({ FACE_INDEX_LONG_EDGE: '8192', FACE_DECODE_MAX_PIXELS: '67108864' }),
    ).not.toThrow();
  });

  it('rejects a strong threshold below the maybe threshold', () => {
    expect(() => loadFaceConfig({ FACE_STRONG: '80', FACE_MAYBE: '85' })).toThrow(
      /FACE_STRONG must be greater than or equal to FACE_MAYBE/,
    );
  });

  it('rejects an encode min long edge above the selfie or index long edge', () => {
    expect(() =>
      loadFaceConfig({ FACE_ENCODE_MIN_LONG_EDGE: '400', FACE_SELFIE_LONG_EDGE: '320' }),
    ).toThrow(/FACE_ENCODE_MIN_LONG_EDGE must be less than or equal to FACE_SELFIE_LONG_EDGE/);
    expect(() =>
      loadFaceConfig({ FACE_ENCODE_MIN_LONG_EDGE: '1000', FACE_INDEX_LONG_EDGE: '640' }),
    ).toThrow(/FACE_ENCODE_MIN_LONG_EDGE must be less than or equal to FACE_INDEX_LONG_EDGE/);
    expect(
      loadFaceConfig({ FACE_ENCODE_MIN_LONG_EDGE: '640', FACE_SELFIE_LONG_EDGE: '640' }).encode
        .minLongEdge,
    ).toBe(640);
  });

  it('rejects a retry base above the retry max in either profile', () => {
    expect(() => loadFaceConfig({ FACE_REKOGNITION_RETRY_BASE_MS: '20000' })).toThrow(
      /FACE_REKOGNITION_RETRY_BASE_MS must be less than or equal to FACE_REKOGNITION_RETRY_MAX_MS/,
    );
    expect(() => loadFaceConfig({ FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS: '50' })).toThrow(
      /FACE_REKOGNITION_INTERACTIVE_RETRY_BASE_MS must be less than or equal to FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS/,
    );
    expect(
      loadFaceConfig({
        FACE_REKOGNITION_INTERACTIVE_RETRY_BASE_MS: '500',
        FACE_REKOGNITION_INTERACTIVE_RETRY_MAX_MS: '500',
      }).rekognition.interactive,
    ).toMatchObject({ retryBaseMs: 500, retryMaxMs: 500 });
  });

  it('rejects values outside their range', () => {
    expect(() => loadFaceConfig({ FACE_MAYBE: '120' })).toThrow(/Invalid face configuration/);
    expect(() => loadFaceConfig({ FACE_INDEX_QUALITY_FILTER: 'ULTRA' })).toThrow();
  });

  it.each([
    ['FACE_ENCODE_SHRINK_FACTOR', '1'],
    ['FACE_ENCODE_SHRINK_FACTOR', '0.4'],
    ['FACE_ENCODE_QUALITY_STEP', '2.5'],
    ['FACE_ENCODE_MIN_QUALITY', '29'],
    ['FACE_ENCODE_MIN_LONG_EDGE', '32'],
    ['FACE_TILE_EDGE_EPSILON', '0.2'],
    ['FACE_REKOGNITION_TPS_INDEX_FACES', '0'],
    ['FACE_REKOGNITION_TPS_SEARCH_FACES', '1001'],
    ['FACE_REKOGNITION_TPS_COLLECTION', '0.5'],
    ['FACE_REKOGNITION_TPS_DELETE_FACES', '2.5'],
    ['FACE_REKOGNITION_TPS_LIST_FACES', '0'],
    ['FACE_REKOGNITION_TPS_LIST_FACES', '1001'],
    ['FACE_REKOGNITION_TPS_SEARCH_FACES_BY_IMAGE', '-5'],
    ['FACE_REKOGNITION_BURST_SECONDS', '0'],
    ['FACE_REKOGNITION_BURST_SECONDS', '1.01'],
    ['FACE_REKOGNITION_BURST_SECONDS', '2.5'],
    ['FACE_REKOGNITION_REQUEST_TIMEOUT_MS', '999'],
    ['FACE_REKOGNITION_REQUEST_TIMEOUT_MS', '120001'],
    ['FACE_REKOGNITION_REQUEST_TIMEOUT_MS', '1500.5'],
    ['FACE_ORPHAN_GRACE_MS', '59999'],
    ['FACE_ORPHAN_GRACE_MS', '86400001'],
    ['FACE_ORPHAN_GRACE_MS', '3600000.5'],
    ['FACE_REKOGNITION_MAX_WAIT_MS', '-1'],
    ['FACE_REKOGNITION_INTERACTIVE_MAX_WAIT_MS', '30001'],
    ['FACE_REKOGNITION_INTERACTIVE_MAX_ATTEMPTS', '11'],
    ['FACE_REKOGNITION_RATE_LIMIT_PREFIX', 'shotx rekognition'],
    ['FACE_REKOGNITION_RATE_LIMIT_PREFIX', 'shotx/{rekognition}'],
    ['FACE_REKOGNITION_RATE_LIMIT_PREFIX', 'x'.repeat(65)],
    ['FACE_SEARCH_RATE_PER_IP', '0'],
    ['FACE_SEARCH_RATE_PER_IP', '2.5'],
    ['FACE_SEARCH_RATE_PER_SHARE', '-1'],
    ['FACE_SEARCH_RATE_PER_VIEWER_WINDOW_SECONDS', '0'],
    ['FACE_SEARCH_RATE_PER_IP_WINDOW_SECONDS', '86401'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadFaceConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadFaceSearchUploadConfig', () => {
  // infra's defaults: min(5 MiB, 1280² × 3) per selfie; 3 selfies + 64 KiB.
  const env = { FACE_SEARCH_MAX_SELFIE_BYTES: '4915200', FACE_SEARCH_MAX_BODY_BYTES: '14811136' };

  it('reads both limits', () => {
    expect(loadFaceSearchUploadConfig(env)).toEqual({
      maxSelfieBytes: 4_915_200,
      maxBodyBytes: 14_811_136,
    });
  });

  it('requires both limits: infra derives them, so there is no default', () => {
    expect(() => loadFaceSearchUploadConfig({})).toThrow(/at FACE_SEARCH_MAX_SELFIE_BYTES\b/);
    expect(() => loadFaceSearchUploadConfig({ FACE_SEARCH_MAX_SELFIE_BYTES: '4915200' })).toThrow(
      /at FACE_SEARCH_MAX_BODY_BYTES\b/,
    );
  });

  it("caps a selfie at Rekognition's 5 MiB inline image limit", () => {
    expect(
      loadFaceSearchUploadConfig({
        FACE_SEARCH_MAX_SELFIE_BYTES: String(5 * 1024 * 1024),
        FACE_SEARCH_MAX_BODY_BYTES: String(16 * 1024 * 1024),
      }).maxSelfieBytes,
    ).toBe(5 * 1024 * 1024);
    expect(() =>
      loadFaceSearchUploadConfig({
        ...env,
        FACE_SEARCH_MAX_SELFIE_BYTES: String(5 * 1024 * 1024 + 1),
      }),
    ).toThrow(/at FACE_SEARCH_MAX_SELFIE_BYTES\b/);
  });

  it('requires the body to fit FACE_MAX_SELFIES selfies', () => {
    expect(() => loadFaceSearchUploadConfig({ ...env, FACE_MAX_SELFIES: '4' })).toThrow(
      /FACE_SEARCH_MAX_BODY_BYTES must fit FACE_MAX_SELFIES/,
    );
    expect(() =>
      loadFaceSearchUploadConfig({ ...env, FACE_SEARCH_MAX_BODY_BYTES: '1000' }),
    ).toThrow(/FACE_SEARCH_MAX_SELFIE_BYTES must be less than or equal to/);
  });
});

describe('loadCostConfig', () => {
  it('uses the spec defaults and accepts overrides', () => {
    expect(loadCostConfig({})).toEqual({
      s3StandardGbMonth: 0.025,
      rekognitionCall: 0.001,
      rekognitionFaceMonth: 0.00001,
      cloudfrontPlanMonth: 200,
      usdThb: 33,
    });
    expect(loadCostConfig({ USD_THB: '36.5' }).usdThb).toBe(36.5);
  });
});
