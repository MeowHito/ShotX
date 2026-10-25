import {
  type BoundingBox as AwsBoundingBox,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DeleteFacesCommand,
  DescribeCollectionCommand,
  type FaceMatch as AwsFaceMatch,
  type Image,
  IndexFacesCommand,
  type IndexFacesCommandOutput,
  ListFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
  SearchFacesCommand,
} from '@aws-sdk/client-rekognition';
import type { FaceConfig } from '@shotx/shared';
import {
  type FaceProvider,
  IndexFacesOutcomeUnknownError,
  type IndexFacesRequest,
  type ListFacesPage,
  type ListFacesRequest,
  NoFaceDetectedError,
  REKOGNITION_DELETE_FACES_BATCH,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from './provider';
import type {
  RekognitionLimiters,
  RekognitionOperation,
  RekognitionProfile,
} from './rekognition-limits';
import { RateLimitedError, type RetryOptions, withRetry } from './throttling';
import type { BoundingBox, FaceMatch, ImageInput, IndexFacesResult } from './types';

/** Rekognition rejected the call for exceeding a rate: nothing was done, so a retry is safe. */
const THROTTLING_NAMES = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException']);
const RETRYABLE_NAMES = new Set([
  ...THROTTLING_NAMES,
  'InternalServerError',
  'ServiceUnavailableException',
  'TimeoutError',
]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

type AwsErrorFields = Error & {
  $retryable?: { throttling?: boolean } | undefined;
  $metadata?: { httpStatusCode?: number } | undefined;
  code?: string | undefined;
};

/**
 * Worth retrying, but the first attempt may have taken effect. Only for calls that are safe to
 * repeat: everything except IndexFaces.
 */
export function isRetryableAwsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as AwsErrorFields;
  return (
    Boolean(e.$retryable) ||
    RETRYABLE_NAMES.has(e.name) ||
    (e.$metadata?.httpStatusCode ?? 0) >= 500 ||
    (e.code !== undefined && RETRYABLE_CODES.has(e.code))
  );
}

/** Rekognition throttled the call, which means it rejected it: retrying never repeats work. */
export function isThrottlingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as AwsErrorFields;
  return THROTTLING_NAMES.has(e.name) || e.$retryable?.throttling === true;
}

/**
 * The call certainly did nothing: the rate limiter refused it before sending, or Rekognition
 * answered with a 4xx (throttling, validation, access, missing collection).
 */
function wasRejected(error: unknown): boolean {
  if (error instanceof RateLimitedError || isThrottlingError(error)) return true;
  const status = (error as AwsErrorFields | undefined)?.$metadata?.httpStatusCode;
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * Errors are matched by name rather than class, so they're recognized even when two copies of the
 * SDK are installed.
 */
function isAwsError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

/**
 * SearchFacesByImage reports an input image without a face as InvalidParameterException with the
 * message "There are no faces in the image. Should be at least 1." Every other invalid parameter
 * (MaxFaces, threshold, image format, …) is a bug and must not turn into "no face".
 */
const NO_FACE_MESSAGE = /\bno faces in the image\b/i;

export function isNoFaceInImageError(error: unknown): boolean {
  return isAwsError(error, 'InvalidParameterException') && NO_FACE_MESSAGE.test(error.message);
}

/** Retry settings of a profile: the API fails fast, the worker keeps trying. */
export function rekognitionRetryOptions(
  config: FaceConfig['rekognition'],
  profile: RekognitionProfile,
): RetryOptions {
  const { maxAttempts, retryBaseMs, retryMaxMs } = config[profile];
  return { maxAttempts, baseDelayMs: retryBaseMs, maxDelayMs: retryMaxMs };
}

export interface RekognitionProviderOptions {
  client: RekognitionClient;
  /** Every call takes a token from its operation's limiter, keeping under the per-operation TPS. */
  limiters: RekognitionLimiters;
  retry: RetryOptions;
}

export class RekognitionFaceProvider implements FaceProvider {
  constructor(private readonly options: RekognitionProviderOptions) {}

  /**
   * Builds the provider for one process. Pass limiters from `createRedisRekognitionLimiters` with
   * the same profile in production. Retries happen here (behind the limiters), so the SDK's own
   * retries are turned off.
   */
  static create(
    config: FaceConfig['rekognition'],
    profile: RekognitionProfile,
    limiters: RekognitionLimiters,
  ): RekognitionFaceProvider {
    return new RekognitionFaceProvider({
      client: new RekognitionClient({ region: config.region, maxAttempts: 1 }),
      limiters,
      retry: rekognitionRetryOptions(config, profile),
    });
  }

  async createCollection(collectionId: string): Promise<{ faceModelVersion?: string }> {
    const { client } = this.options;
    try {
      const out = await this.call('CreateCollection', () =>
        client.send(new CreateCollectionCommand({ CollectionId: collectionId })),
      );
      return { faceModelVersion: out.FaceModelVersion };
    } catch (error) {
      if (!isAwsError(error, 'ResourceAlreadyExistsException')) throw error;
      const out = await this.call('DescribeCollection', () =>
        client.send(new DescribeCollectionCommand({ CollectionId: collectionId })),
      );
      return { faceModelVersion: out.FaceModelVersion };
    }
  }

  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await this.call('DeleteCollection', () =>
        this.options.client.send(new DeleteCollectionCommand({ CollectionId: collectionId })),
      );
    } catch (error) {
      if (!isAwsError(error, 'ResourceNotFoundException')) throw error;
    }
  }

  /**
   * IndexFaces is not idempotent, so only throttling is retried: a throttled request was
   * rejected. After a 5xx, a timeout or a dropped connection the faces may already be indexed, and
   * a retry would index them twice, so the call fails with IndexFacesOutcomeUnknownError instead.
   */
  async indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult> {
    let out: IndexFacesCommandOutput;
    try {
      out = await this.call(
        'IndexFaces',
        () =>
          this.options.client.send(
            new IndexFacesCommand({
              CollectionId: request.collectionId,
              Image: toImage(request.image),
              ExternalImageId: request.externalImageId,
              MaxFaces: request.maxFaces,
              QualityFilter: request.qualityFilter,
            }),
          ),
        isThrottlingError,
      );
    } catch (error) {
      if (wasRejected(error)) throw error;
      throw new IndexFacesOutcomeUnknownError(error);
    }
    return {
      faces: (out.FaceRecords ?? []).flatMap(({ Face: face }) =>
        face?.FaceId
          ? [
              {
                faceId: face.FaceId,
                bbox: toBox(face.BoundingBox),
                confidence: face.Confidence ?? 0,
              },
            ]
          : [],
      ),
      unindexed: (out.UnindexedFaces ?? []).map((face) => ({
        bbox: toBox(face.FaceDetail?.BoundingBox),
        reasons: face.Reasons ?? [],
      })),
    };
  }

  async searchFacesByImage(request: SearchByImageRequest): Promise<FaceMatch[]> {
    try {
      const out = await this.call('SearchFacesByImage', () =>
        this.options.client.send(
          new SearchFacesByImageCommand({
            CollectionId: request.collectionId,
            Image: { Bytes: request.image },
            FaceMatchThreshold: request.threshold,
            MaxFaces: request.maxFaces,
            QualityFilter: request.qualityFilter,
          }),
        ),
      );
      return toMatches(out.FaceMatches);
    } catch (error) {
      if (isNoFaceInImageError(error)) throw new NoFaceDetectedError();
      throw error;
    }
  }

  async searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]> {
    const out = await this.call('SearchFaces', () =>
      this.options.client.send(
        new SearchFacesCommand({
          CollectionId: request.collectionId,
          FaceId: request.faceId,
          FaceMatchThreshold: request.threshold,
          MaxFaces: request.maxFaces,
        }),
      ),
    );
    return toMatches(out.FaceMatches);
  }

  async deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    for (let start = 0; start < faceIds.length; start += REKOGNITION_DELETE_FACES_BATCH) {
      const batch = faceIds.slice(start, start + REKOGNITION_DELETE_FACES_BATCH);
      await this.call('DeleteFaces', () =>
        this.options.client.send(
          new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: batch }),
        ),
      );
    }
  }

  async listFaces(request: ListFacesRequest): Promise<ListFacesPage> {
    const out = await this.call('ListFaces', () =>
      this.options.client.send(
        new ListFacesCommand({
          CollectionId: request.collectionId,
          MaxResults: request.maxResults,
          NextToken: request.nextToken,
        }),
      ),
    );
    return {
      faces: (out.Faces ?? []).flatMap((face) =>
        face.FaceId ? [{ faceId: face.FaceId, externalImageId: face.ExternalImageId }] : [],
      ),
      nextToken: out.NextToken || undefined,
    };
  }

  /** Each attempt, retries included, is a real call and takes its own token. */
  private call<T>(
    operation: RekognitionOperation,
    send: () => Promise<T>,
    isRetryable: (error: unknown) => boolean = isRetryableAwsError,
  ): Promise<T> {
    const limiter = this.options.limiters[operation];
    return withRetry(
      async () => {
        await limiter.acquire();
        return send();
      },
      isRetryable,
      this.options.retry,
    );
  }
}

function toImage(image: ImageInput): Image {
  return 'bytes' in image
    ? { Bytes: image.bytes }
    : { S3Object: { Bucket: image.s3.bucket, Name: image.s3.key } };
}

function toBox(box: AwsBoundingBox | undefined): BoundingBox {
  return {
    left: box?.Left ?? 0,
    top: box?.Top ?? 0,
    width: box?.Width ?? 0,
    height: box?.Height ?? 0,
  };
}

function toMatches(matches: AwsFaceMatch[] | undefined): FaceMatch[] {
  return (matches ?? []).flatMap(({ Face: face, Similarity: similarity }) =>
    face?.FaceId && similarity !== undefined
      ? [{ faceId: face.FaceId, similarity, externalImageId: face.ExternalImageId }]
      : [],
  );
}
