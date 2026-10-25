import type { DeleteFacesCommand, IndexFacesCommand } from '@aws-sdk/client-rekognition';
import {
  CreateCollectionCommand,
  DescribeCollectionCommand,
  InternalServerError,
  InvalidParameterException,
  InvalidS3ObjectException,
  ListFacesCommand,
  ProvisionedThroughputExceededException,
  type RekognitionClient,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
  SearchFacesByImageCommand,
  SearchFacesCommand,
  ThrottlingException,
} from '@aws-sdk/client-rekognition';
import { loadFaceConfig } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { IndexFacesOutcomeUnknownError, NoFaceDetectedError } from './provider';
import {
  type RekognitionLimiters,
  type RekognitionOperation,
  REKOGNITION_OPERATIONS,
} from './rekognition-limits';
import {
  isNoFaceInImageError,
  isThrottlingError,
  RekognitionFaceProvider,
  rekognitionRetryOptions,
} from './rekognition-provider';
import { RateLimitedError } from './throttling';

const meta = { $metadata: { httpStatusCode: 400 } };
const noFace = () =>
  new InvalidParameterException({
    ...meta,
    message: 'There are no faces in the image. Should be at least 1.',
  });
const badMaxFaces = () =>
  new InvalidParameterException({
    ...meta,
    message:
      "1 validation error detected: Value '5000' at 'maxFaces' failed to satisfy constraint: Member must have value less than or equal to 4096",
  });

function setup(responses: Array<unknown>) {
  const acquired: RekognitionOperation[] = [];
  const limiters = Object.fromEntries(
    REKOGNITION_OPERATIONS.map((op) => [
      op,
      {
        acquire: () => {
          acquired.push(op);
          return Promise.resolve();
        },
      },
    ]),
  ) as unknown as RekognitionLimiters;
  const send = vi.fn((_command: unknown) => {
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? {});
  });
  const provider = new RekognitionFaceProvider({
    client: { send } as unknown as RekognitionClient,
    limiters,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() },
  });
  return { provider, send, acquired };
}

const search = {
  collectionId: 'pg-1',
  image: new Uint8Array([1, 2, 3]),
  threshold: 85,
  maxFaces: 1000,
  qualityFilter: 'AUTO' as const,
};

describe('searchFacesByImage', () => {
  it('maps matches and takes a SearchFacesByImage token', async () => {
    const { provider, send, acquired } = setup([
      {
        FaceMatches: [
          { Similarity: 97.5, Face: { FaceId: 'f1', ExternalImageId: 'file-1' } },
          { Similarity: 90, Face: {} },
        ],
      },
    ]);
    await expect(provider.searchFacesByImage(search)).resolves.toEqual([
      { faceId: 'f1', similarity: 97.5, externalImageId: 'file-1' },
    ]);
    expect(acquired).toEqual(['SearchFacesByImage']);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(SearchFacesByImageCommand);
    expect((command as SearchFacesByImageCommand).input).toMatchObject({
      CollectionId: 'pg-1',
      FaceMatchThreshold: 85,
      MaxFaces: 1000,
      QualityFilter: 'AUTO',
    });
  });

  it('reports an image without a face as NoFaceDetectedError', async () => {
    const { provider } = setup([noFace()]);
    await expect(provider.searchFacesByImage(search)).rejects.toBeInstanceOf(NoFaceDetectedError);
  });

  it('propagates every other InvalidParameterException', async () => {
    for (const error of [
      badMaxFaces(),
      new InvalidParameterException({ ...meta, message: 'Request has invalid parameters' }),
      new InvalidParameterException({ ...meta, message: 'Invalid face id' }),
    ]) {
      const { provider } = setup([error]);
      await expect(provider.searchFacesByImage(search)).rejects.toBe(error);
    }
  });
});

describe('isNoFaceInImageError', () => {
  it('recognizes the no-face error by name, also from another SDK copy', () => {
    const copy = Object.assign(
      new Error('There are no faces in the image. Should be at least 1.'),
      {
        name: 'InvalidParameterException',
      },
    );
    expect(isNoFaceInImageError(noFace())).toBe(true);
    expect(isNoFaceInImageError(copy)).toBe(true);
  });

  it('ignores other errors that mention faces', () => {
    expect(isNoFaceInImageError(badMaxFaces())).toBe(false);
    expect(isNoFaceInImageError(new Error('There are no faces in the image.'))).toBe(false);
    expect(
      isNoFaceInImageError({ name: 'InvalidParameterException', message: 'no faces in the image' }),
    ).toBe(false);
  });
});

describe('throttling and retries', () => {
  it('retries ThrottlingException and takes a token for every attempt', async () => {
    const throttled = () => new ThrottlingException({ ...meta, message: 'Rate exceeded' });
    const { provider, send, acquired } = setup([throttled(), throttled(), { FaceMatches: [] }]);
    await expect(
      provider.searchFaces({ collectionId: 'pg-1', faceId: 'f1', threshold: 85, maxFaces: 10 }),
    ).resolves.toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(SearchFacesCommand);
    expect(acquired).toEqual(['SearchFaces', 'SearchFaces', 'SearchFaces']);
  });

  it('does not retry a rate-limited call', async () => {
    const { send } = setup([]);
    const limited = new RateLimitedError('k', 5000);
    const limiters = Object.fromEntries(
      REKOGNITION_OPERATIONS.map((op) => [op, { acquire: () => Promise.reject(limited) }]),
    ) as unknown as RekognitionLimiters;
    const strict = new RekognitionFaceProvider({
      client: { send } as unknown as RekognitionClient,
      limiters,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() },
    });
    await expect(strict.searchFacesByImage(search)).rejects.toBe(limited);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('indexing and collections', () => {
  it('indexes faces with an IndexFaces token and maps unindexed faces', async () => {
    const { provider, send, acquired } = setup([
      {
        FaceRecords: [
          {
            Face: {
              FaceId: 'f1',
              Confidence: 99,
              BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.05, Height: 0.06 },
            },
          },
        ],
        UnindexedFaces: [{ Reasons: ['SMALL_BOUNDING_BOX'], FaceDetail: {} }],
      },
    ]);
    const result = await provider.indexFaces({
      collectionId: 'pg-1',
      image: { s3: { bucket: 'b', key: 'tmp/index/x.jpg' } },
      externalImageId: 'file-1',
      maxFaces: 100,
      qualityFilter: 'LOW',
    });
    expect(result).toEqual({
      faces: [
        { faceId: 'f1', confidence: 99, bbox: { left: 0.1, top: 0.2, width: 0.05, height: 0.06 } },
      ],
      unindexed: [
        { reasons: ['SMALL_BOUNDING_BOX'], bbox: { left: 0, top: 0, width: 0, height: 0 } },
      ],
    });
    expect(acquired).toEqual(['IndexFaces']);
    expect((send.mock.calls[0]![0] as IndexFacesCommand).input.Image).toEqual({
      S3Object: { Bucket: 'b', Name: 'tmp/index/x.jpg' },
    });
  });

  it('deletes faces in batches of 4096', async () => {
    const { provider, send, acquired } = setup([]);
    const ids = Array.from({ length: 5000 }, (_, i) => `f${i}`);
    await provider.deleteFaces('pg-1', ids);
    expect(send).toHaveBeenCalledTimes(2);
    const batches = send.mock.calls.map(([c]) => (c as DeleteFacesCommand).input.FaceIds?.length);
    expect(batches).toEqual([4096, 904]);
    expect(acquired).toEqual(['DeleteFaces', 'DeleteFaces']);
  });

  it('describes an existing collection instead of failing', async () => {
    const exists = new ResourceAlreadyExistsException({ ...meta, message: 'exists' });
    const { provider, send, acquired } = setup([exists, { FaceModelVersion: '7.0' }]);
    await expect(provider.createCollection('pg-1')).resolves.toEqual({ faceModelVersion: '7.0' });
    expect(send.mock.calls.map(([c]) => c?.constructor)).toEqual([
      CreateCollectionCommand,
      DescribeCollectionCommand,
    ]);
    expect(acquired).toEqual(['CreateCollection', 'DescribeCollection']);
  });

  it('ignores deleting a collection that does not exist', async () => {
    const missing = new ResourceNotFoundException({ ...meta, message: 'missing' });
    const { provider, acquired } = setup([missing]);
    await expect(provider.deleteCollection('pg-1')).resolves.toBeUndefined();
    expect(acquired).toEqual(['DeleteCollection']);
  });
});

describe('IndexFaces retries', () => {
  const request = {
    collectionId: 'pg-1',
    image: { s3: { bucket: 'b', key: 'tmp/index/file-1/a/full.jpg' } },
    externalImageId: 'file-1',
    maxFaces: 100,
    qualityFilter: 'LOW' as const,
  };
  const throttled = () => new ThrottlingException({ ...meta, message: 'Rate exceeded' });

  it('retries throttling, which means the request was rejected', async () => {
    const throughput = new ProvisionedThroughputExceededException({
      ...meta,
      message: 'slow down',
    });
    const { provider, send, acquired } = setup([throttled(), throughput, { FaceRecords: [] }]);
    await expect(provider.indexFaces(request)).resolves.toEqual({ faces: [], unindexed: [] });
    expect(send).toHaveBeenCalledTimes(3);
    expect(acquired).toEqual(['IndexFaces', 'IndexFaces', 'IndexFaces']);
  });

  it('passes throttling through unwrapped once the attempts run out', async () => {
    const last = throttled();
    const { provider, send } = setup([throttled(), throttled(), last]);
    await expect(provider.indexFaces(request)).rejects.toBe(last);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('never retries after a failure that may have indexed faces', async () => {
    const ambiguous = [
      new InternalServerError({ $metadata: { httpStatusCode: 500 }, message: 'internal' }),
      Object.assign(new Error('unavailable'), {
        name: 'ServiceUnavailableException',
        $metadata: { httpStatusCode: 503 },
      }),
      Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new Error('retry me'), { $retryable: {} }),
    ];
    for (const error of ambiguous) {
      const { provider, send } = setup([error, { FaceRecords: [] }]);
      const thrown: unknown = await provider.indexFaces(request).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(IndexFacesOutcomeUnknownError);
      expect((thrown as Error).cause).toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('passes rejected requests through unchanged', async () => {
    for (const error of [
      new InvalidS3ObjectException({ ...meta, message: 'cannot read object' }),
      badMaxFaces(),
      new ResourceNotFoundException({ ...meta, message: 'no collection' }),
    ]) {
      const { provider, send } = setup([error]);
      await expect(provider.indexFaces(request)).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('passes a refused rate-limit token through without sending', async () => {
    const { send } = setup([]);
    const limited = new RateLimitedError('IndexFaces', 40_000);
    const limiters = Object.fromEntries(
      REKOGNITION_OPERATIONS.map((op) => [op, { acquire: () => Promise.reject(limited) }]),
    ) as unknown as RekognitionLimiters;
    const provider = new RekognitionFaceProvider({
      client: { send } as unknown as RekognitionClient,
      limiters,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() },
    });
    await expect(provider.indexFaces(request)).rejects.toBe(limited);
    expect(send).not.toHaveBeenCalled();
  });

  it('still retries calls that are safe to repeat after a 5xx', async () => {
    const { provider, send } = setup([
      new InternalServerError({ $metadata: { httpStatusCode: 500 }, message: 'internal' }),
      {},
    ]);
    await provider.deleteFaces('pg-1', ['f1']);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('isThrottlingError', () => {
  it('recognizes throttling by name or by the SDK flag', () => {
    expect(isThrottlingError(new ThrottlingException({ ...meta, message: 'x' }))).toBe(true);
    expect(
      isThrottlingError(Object.assign(new Error('x'), { $retryable: { throttling: true } })),
    ).toBe(true);
    expect(isThrottlingError(Object.assign(new Error('x'), { $retryable: {} }))).toBe(false);
    expect(isThrottlingError(new RateLimitedError('k', 1))).toBe(false);
    expect(isThrottlingError('ThrottlingException')).toBe(false);
  });
});

describe('listFaces', () => {
  it('pages with NextToken and takes a ListFaces token', async () => {
    const { provider, send, acquired } = setup([
      {
        Faces: [
          { FaceId: 'f1', ExternalImageId: 'file-1' },
          { FaceId: 'f2' },
          { ExternalImageId: 'x' },
        ],
        NextToken: 'next',
      },
      { Faces: [] },
    ]);
    await expect(provider.listFaces({ collectionId: 'pg-1', maxResults: 4096 })).resolves.toEqual({
      faces: [
        { faceId: 'f1', externalImageId: 'file-1' },
        { faceId: 'f2', externalImageId: undefined },
      ],
      nextToken: 'next',
    });
    await expect(
      provider.listFaces({ collectionId: 'pg-1', maxResults: 10, nextToken: 'next' }),
    ).resolves.toEqual({ faces: [], nextToken: undefined });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(ListFacesCommand);
    expect((send.mock.calls[1]![0] as ListFacesCommand).input).toEqual({
      CollectionId: 'pg-1',
      MaxResults: 10,
      NextToken: 'next',
    });
    expect(acquired).toEqual(['ListFaces', 'ListFaces']);
  });
});

describe('rekognitionRetryOptions', () => {
  it('uses the profile from FaceConfig', () => {
    const config = loadFaceConfig({}).rekognition;
    expect(rekognitionRetryOptions(config, 'interactive')).toEqual({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
    expect(rekognitionRetryOptions(config, 'background')).toEqual({
      maxAttempts: 8,
      baseDelayMs: 200,
      maxDelayMs: 10_000,
    });
  });
});
