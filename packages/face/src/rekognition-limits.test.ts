import { loadFaceConfig } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RedisScriptClient, RedisTokenBucket } from './redis-token-bucket';
import {
  createLocalRekognitionLimiters,
  createRedisRekognitionLimiters,
  operationTps,
  REKOGNITION_OPERATIONS,
  rekognitionBucketKey,
} from './rekognition-limits';
import { TokenBucket } from './throttling';

const config = loadFaceConfig({
  FACE_REKOGNITION_TPS_INDEX_FACES: '2',
  FACE_REKOGNITION_TPS_SEARCH_FACES_BY_IMAGE: '20',
  FACE_REKOGNITION_TPS_SEARCH_FACES: '10',
  FACE_REKOGNITION_TPS_DELETE_FACES: '4',
  FACE_REKOGNITION_TPS_COLLECTION: '1',
  FACE_REKOGNITION_RATE_LIMIT_PREFIX: 'prod-123',
}).rekognition;

const redis: RedisScriptClient = { evalsha: vi.fn(), eval: vi.fn() };

describe('operationTps', () => {
  it('maps every operation to its own quota', () => {
    expect(REKOGNITION_OPERATIONS.map((op) => [op, operationTps(config, op)])).toEqual([
      ['IndexFaces', 2],
      ['SearchFacesByImage', 20],
      ['SearchFaces', 10],
      ['DeleteFaces', 4],
      ['CreateCollection', 1],
      ['DescribeCollection', 1],
      ['DeleteCollection', 1],
    ]);
  });
});

describe('rekognitionBucketKey', () => {
  it('scopes keys by prefix, region and operation', () => {
    expect(rekognitionBucketKey(config, 'SearchFacesByImage')).toBe(
      'prod-123:ap-southeast-1:SearchFacesByImage',
    );
  });
});

describe('createRedisRekognitionLimiters', () => {
  it('gives each operation its own Redis bucket', () => {
    const limiters = createRedisRekognitionLimiters(redis, config, 'background');
    const keys = REKOGNITION_OPERATIONS.map((op) => (limiters[op] as RedisTokenBucket).key);
    expect(new Set(keys).size).toBe(REKOGNITION_OPERATIONS.length);
    expect((limiters.SearchFacesByImage as RedisTokenBucket).params).toMatchObject({
      capacity: 20,
      intervalUs: 50_000,
    });
  });

  it('takes the maximum wait from the profile', () => {
    const api = createRedisRekognitionLimiters(redis, config, 'interactive');
    const worker = createRedisRekognitionLimiters(redis, config, 'background');
    expect((api.SearchFacesByImage as RedisTokenBucket).params.maxWaitUs).toBe(
      config.interactive.maxWaitMs * 1000,
    );
    expect((worker.IndexFaces as RedisTokenBucket).params.maxWaitUs).toBe(
      config.background.maxWaitMs * 1000,
    );
  });
});

describe('createLocalRekognitionLimiters', () => {
  it('builds in-process buckets for every operation', () => {
    const limiters = createLocalRekognitionLimiters(config);
    for (const op of REKOGNITION_OPERATIONS) expect(limiters[op]).toBeInstanceOf(TokenBucket);
  });
});
