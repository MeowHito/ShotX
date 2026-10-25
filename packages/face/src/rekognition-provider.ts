import {
  type BoundingBox as AwsBoundingBox,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DeleteFacesCommand,
  DescribeCollectionCommand,
  type FaceMatch as AwsFaceMatch,
  type Image,
  IndexFacesCommand,
  InvalidParameterException,
  RekognitionClient,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
  SearchFacesByImageCommand,
  SearchFacesCommand,
} from '@aws-sdk/client-rekognition';
import type { FaceConfig } from '@shotx/shared';
import {
  type FaceProvider,
  type IndexFacesRequest,
  NoFaceDetectedError,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from './provider';
import { type RateLimiter, type RetryOptions, TokenBucket, withRetry } from './throttling';
import type { BoundingBox, FaceMatch, ImageInput, IndexFacesResult } from './types';

const DELETE_FACES_BATCH = 4096;

const RETRYABLE_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'InternalServerError',
  'ServiceUnavailableException',
  'TimeoutError',
]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

export function isRetryableAwsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & {
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
    code?: string;
  };
  return (
    Boolean(e.$retryable) ||
    RETRYABLE_NAMES.has(e.name) ||
    (e.$metadata?.httpStatusCode ?? 0) >= 500 ||
    (e.code !== undefined && RETRYABLE_CODES.has(e.code))
  );
}

export interface RekognitionProviderOptions {
  client: RekognitionClient;
  /** Every call takes a token, keeping the account under its Rekognition TPS quota. */
  limiter: RateLimiter;
  retry: RetryOptions;
}

export class RekognitionFaceProvider implements FaceProvider {
  constructor(private readonly options: RekognitionProviderOptions) {}

  /** Retries happen here (with the limiter), so the SDK's own retries are turned off. */
  static create(config: FaceConfig['rekognition']): RekognitionFaceProvider {
    return new RekognitionFaceProvider({
      client: new RekognitionClient({ region: config.region, maxAttempts: 1 }),
      limiter: new TokenBucket(config.tps),
      retry: {
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.retryBaseMs,
        maxDelayMs: config.retryMaxMs,
      },
    });
  }

  async createCollection(collectionId: string): Promise<{ faceModelVersion?: string }> {
    const { client } = this.options;
    try {
      const out = await this.call(() =>
        client.send(new CreateCollectionCommand({ CollectionId: collectionId })),
      );
      return { faceModelVersion: out.FaceModelVersion };
    } catch (error) {
      if (!(error instanceof ResourceAlreadyExistsException)) throw error;
      const out = await this.call(() =>
        client.send(new DescribeCollectionCommand({ CollectionId: collectionId })),
      );
      return { faceModelVersion: out.FaceModelVersion };
    }
  }

  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await this.call(() =>
        this.options.client.send(new DeleteCollectionCommand({ CollectionId: collectionId })),
      );
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }

  async indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult> {
    const out = await this.call(() =>
      this.options.client.send(
        new IndexFacesCommand({
          CollectionId: request.collectionId,
          Image: toImage(request.image),
          ExternalImageId: request.externalImageId,
          MaxFaces: request.maxFaces,
          QualityFilter: request.qualityFilter,
        }),
      ),
    );
    return {
      faces: (out.FaceRecords ?? []).flatMap(({ Face: face }) =>
        face?.FaceId
          ? [{ faceId: face.FaceId, bbox: toBox(face.BoundingBox), confidence: face.Confidence ?? 0 }]
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
      const out = await this.call(() =>
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
      // Rekognition reports "There are no faces in the image" as an invalid parameter.
      if (error instanceof InvalidParameterException && /face/i.test(error.message)) {
        throw new NoFaceDetectedError();
      }
      throw error;
    }
  }

  async searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]> {
    const out = await this.call(() =>
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
    for (let start = 0; start < faceIds.length; start += DELETE_FACES_BATCH) {
      const batch = faceIds.slice(start, start + DELETE_FACES_BATCH);
      await this.call(() =>
        this.options.client.send(
          new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: batch }),
        ),
      );
    }
  }

  private call<T>(send: () => Promise<T>): Promise<T> {
    return withRetry(
      async () => {
        await this.options.limiter.acquire();
        return send();
      },
      isRetryableAwsError,
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
