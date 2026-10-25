import { describe, expect, it } from 'vitest';
import { loadCostConfig } from './cost';
import { loadFaceConfig } from './face';

describe('loadFaceConfig', () => {
  it('uses the spec defaults', () => {
    const config = loadFaceConfig({});
    expect(config.thresholds).toEqual({ strong: 95, maybe: 85 });
    expect(config.search).toMatchObject({ maxSelfies: 3, expansionSeeds: 2 });
    expect(config.index).toMatchObject({ longEdge: 3500, jpegQuality: 90, maxFaces: 100 });
    expect(config.index.qualityFilter).toBe('LOW');
    expect(config.rekognition.region).toBe('ap-southeast-1');
  });

  it('reads overrides from the environment', () => {
    const config = loadFaceConfig({ FACE_STRONG: '97', FACE_MAYBE: '80', FACE_TILE_GRID: '3' });
    expect(config.thresholds).toEqual({ strong: 97, maybe: 80 });
    expect(config.index.tileGrid).toBe(3);
  });

  it('treats empty variables as unset', () => {
    expect(loadFaceConfig({ FACE_STRONG: '' }).thresholds.strong).toBe(95);
  });

  it('rejects a strong threshold below the maybe threshold', () => {
    expect(() => loadFaceConfig({ FACE_STRONG: '80', FACE_MAYBE: '85' })).toThrow(
      /FACE_STRONG must be greater than or equal to FACE_MAYBE/,
    );
  });

  it('rejects values outside their range', () => {
    expect(() => loadFaceConfig({ FACE_MAYBE: '120' })).toThrow(/Invalid face configuration/);
    expect(() => loadFaceConfig({ FACE_INDEX_QUALITY_FILTER: 'ULTRA' })).toThrow();
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
