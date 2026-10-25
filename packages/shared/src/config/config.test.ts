import { describe, expect, expectTypeOf, it } from 'vitest';
import { loadCostConfig } from './cost';
import { loadFaceConfig } from './face';

describe('loadFaceConfig', () => {
  it('uses the spec defaults', () => {
    const config = loadFaceConfig({});
    expect(config.thresholds).toEqual({ strong: 95, maybe: 85 });
    expect(config.search).toMatchObject({ maxSelfies: 3, expansionSeeds: 2 });
    expect(config.index).toMatchObject({ longEdge: 3500, jpegQuality: 90, maxFaces: 100 });
    expect(config.index.qualityFilter).toBe('LOW');
    expect(config.index.tileEdgeEpsilon).toBe(0.01);
    expect(config.rekognition.region).toBe('ap-southeast-1');
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
          collection: 5,
        },
      },
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
      FACE_REKOGNITION_TPS_COLLECTION: '0.5',
      FACE_REKOGNITION_BURST_SECONDS: '2.5',
      FACE_REKOGNITION_RATE_LIMIT_PREFIX: 'shotx-staging:rekognition.v2',
      FACE_REKOGNITION_INTERACTIVE_MAX_WAIT_MS: '500',
      FACE_REKOGNITION_INTERACTIVE_MAX_ATTEMPTS: '2',
      FACE_TILE_EDGE_EPSILON: '0.02',
      FACE_ENCODE_SHRINK_FACTOR: '0.7',
      FACE_ENCODE_MIN_LONG_EDGE: '640',
    });
    expect(config.rekognition.rateLimit).toEqual({
      keyPrefix: 'shotx-staging:rekognition.v2',
      burstSeconds: 2.5,
      tps: {
        indexFaces: 5,
        searchFacesByImage: 50,
        searchFaces: 5,
        deleteFaces: 5,
        collection: 0.5,
      },
    });
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
    expect(Object.values(rekognition.rateLimit.tps)).toEqual([5, 5, 5, 5, 5]);
    expectTypeOf(rekognition).not.toHaveProperty('tps');
  });

  it('treats empty variables as unset', () => {
    expect(loadFaceConfig({ FACE_STRONG: '' }).thresholds.strong).toBe(95);
    expect(
      loadFaceConfig({ FACE_REKOGNITION_RATE_LIMIT_PREFIX: '' }).rekognition.rateLimit,
    ).toMatchObject({ keyPrefix: 'shotx:rekognition' });
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
    ['FACE_REKOGNITION_BURST_SECONDS', '11'],
    ['FACE_REKOGNITION_MAX_WAIT_MS', '-1'],
    ['FACE_REKOGNITION_INTERACTIVE_MAX_WAIT_MS', '30001'],
    ['FACE_REKOGNITION_INTERACTIVE_MAX_ATTEMPTS', '11'],
    ['FACE_REKOGNITION_RATE_LIMIT_PREFIX', 'shotx rekognition'],
    ['FACE_REKOGNITION_RATE_LIMIT_PREFIX', 'shotx/{rekognition}'],
    ['FACE_REKOGNITION_RATE_LIMIT_PREFIX', 'x'.repeat(65)],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadFaceConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
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
