import {
  type BoundingBox as AwsBoundingBox,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DeleteFacesCommand,
  DescribeCollectionCommand,
  type FaceMatch as AwsFaceMatch,
  IndexFacesCommand,
  type IndexFacesCommandOutput,
  ListFacesCommand,
  RekognitionClient,
  type RekognitionClientConfig,
  SearchFacesByImageCommand,
  SearchFacesCommand,
} from '@aws-sdk/client-rekognition';
import { type AwsClientConfig, awsClientOptions, type FaceConfig } from '@shotx/shared';
import {
  type FaceProvider,
  ImageTooLargeError,
  IndexFacesOutcomeUnknownError,
  type IndexFacesRequest,
  type ListFacesPage,
  type ListFacesRequest,
  NoFaceDetectedError,
  REKOGNITION_DELETE_FACES_BATCH,
  REKOGNITION_INLINE_MAX_BYTES,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from './provider';
import type {
  RekognitionLimiters,
  RekognitionOperation,
  RekognitionProfile,
} from './rekognition-limits';
import { RateLimitedError, type RetryOptions, withRetry } from './throttling';
import type { BoundingBox, FaceMatch, IndexFacesResult } from './types';

/**
 * One Rekognition request took longer than `requestTimeoutMs` and was aborted. The request may
 * have reached the service, so for IndexFaces the outcome is unknown. Named `TimeoutError` like
 * the SDK's own timeouts, so both are handled the same way.
 */
export class RekognitionRequestTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`Rekognition ${operation} request did not finish within ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

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

/**
 * SDK client settings for the provider. Retries happen in the provider (behind the limiters), so
 * the SDK's own retries are off. The request handler gets `requestTimeoutMs` as its connection
 * timeout and as a request timeout that fails the request (not just a warning); the provider also
 * aborts every request at `requestTimeoutMs` (see `RekognitionProviderOptions.requestTimeoutMs`),
 * which covers what the handler doesn't: credential resolution and a response body that stalls.
 */
export function rekognitionClientConfig(
  config: FaceConfig['rekognition'],
): RekognitionClientConfig {
  return {
    region: config.region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: config.requestTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
  };
}

/**
 * The full SDK client config: `rekognitionClientConfig` plus the client's region, endpoint and
 * credentials from `loadRekognitionClientConfig` (packages/shared, ADR 0008 section 1). The
 * endpoint and the credentials are set only when configured: without an endpoint the SDK uses
 * Rekognition's regional endpoint, and without credentials the default chain (on AWS: the task
 * role). Off AWS the shared loader requires keys and refuses AWS_ENDPOINT_URL. Contains the secret
 * key: never log it.
 */
export function rekognitionSdkConfig(
  config: FaceConfig['rekognition'],
  client: AwsClientConfig,
): RekognitionClientConfig {
  return { ...rekognitionClientConfig(config), ...awsClientOptions(client) };
}

export interface RekognitionProviderOptions {
  client: RekognitionClient;
  /** Every call takes a token from its operation's limiter, keeping under the per-operation TPS. */
  limiters: RekognitionLimiters;
  retry: RetryOptions;
  /**
   * Longest one request (one `client.send`, i.e. one attempt) may take, from sending to the parsed
   * response. The request is then aborted and fails with RekognitionRequestTimeoutError, so a hung
   * socket can't hold a call. Rate-limit waits and retry backoff come on top: see
   * `rekognitionCallWorstCaseMs`.
   */
  requestTimeoutMs: number;
}

export class RekognitionFaceProvider implements FaceProvider {
  constructor(private readonly options: RekognitionProviderOptions) {}

  /**
   * Builds the provider for one process. Pass limiters from `createRedisRekognitionLimiters` with
   * the same profile in production, and `client` from `loadRekognitionClientConfig(env)`, so the
   * endpoint and credentials are explicit and never come from AWS_ENDPOINT_URL. Retries happen
   * here (behind the limiters), so the SDK's own retries are turned off; every request is bounded
   * by `config.requestTimeoutMs`.
   */
  static create(
    config: FaceConfig['rekognition'],
    profile: RekognitionProfile,
    limiters: RekognitionLimiters,
    client: AwsClientConfig,
  ): RekognitionFaceProvider {
    return new RekognitionFaceProvider({
      client: new RekognitionClient(rekognitionSdkConfig(config, client)),
      limiters,
      retry: rekognitionRetryOptions(config, profile),
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  async createCollection(collectionId: string): Promise<{ faceModelVersion?: string }> {
    const { client } = this.options;
    try {
      const out = await this.call('CreateCollection', (http) =>
        client.send(new CreateCollectionCommand({ CollectionId: collectionId }), http),
      );
      return { faceModelVersion: out.FaceModelVersion };
    } catch (error) {
      if (!isAwsError(error, 'ResourceAlreadyExistsException')) throw error;
      const out = await this.call('DescribeCollection', (http) =>
        client.send(new DescribeCollectionCommand({ CollectionId: collectionId }), http),
      );
      return { faceModelVersion: out.FaceModelVersion };
    }
  }

  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await this.call('DeleteCollection', (http) =>
        this.options.client.send(new DeleteCollectionCommand({ CollectionId: collectionId }), http),
      );
    } catch (error) {
      if (!isAwsError(error, 'ResourceNotFoundException')) throw error;
    }
  }

  /**
   * IndexFaces is not idempotent, so only throttling is retried: a throttled request was
   * rejected. After a 5xx, a timeout (`requestTimeoutMs` included) or a dropped connection the
   * faces may already be indexed, and a retry would index them twice, so the call fails with
   * IndexFacesOutcomeUnknownError instead. Images above REKOGNITION_INLINE_MAX_BYTES fail with
   * ImageTooLargeError before anything is sent.
   */
  async indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult> {
    assertInlineSize(request.image.bytes);
    let out: IndexFacesCommandOutput;
    try {
      out = await this.call(
        'IndexFaces',
        (http) =>
          this.options.client.send(
            new IndexFacesCommand({
              CollectionId: request.collectionId,
              Image: { Bytes: request.image.bytes },
              ExternalImageId: request.externalImageId,
              MaxFaces: request.maxFaces,
              QualityFilter: request.qualityFilter,
            }),
            http,
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
    assertInlineSize(request.image);
    try {
      const out = await this.call('SearchFacesByImage', (http) =>
        this.options.client.send(
          new SearchFacesByImageCommand({
            CollectionId: request.collectionId,
            Image: { Bytes: request.image },
            FaceMatchThreshold: request.threshold,
            MaxFaces: request.maxFaces,
            QualityFilter: request.qualityFilter,
          }),
          http,
        ),
      );
      return toMatches(out.FaceMatches);
    } catch (error) {
      if (isNoFaceInImageError(error)) throw new NoFaceDetectedError();
      throw error;
    }
  }

  async searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]> {
    const out = await this.call('SearchFaces', (http) =>
      this.options.client.send(
        new SearchFacesCommand({
          CollectionId: request.collectionId,
          FaceId: request.faceId,
          FaceMatchThreshold: request.threshold,
          MaxFaces: request.maxFaces,
        }),
        http,
      ),
    );
    return toMatches(out.FaceMatches);
  }

  async deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    for (let start = 0; start < faceIds.length; start += REKOGNITION_DELETE_FACES_BATCH) {
      const batch = faceIds.slice(start, start + REKOGNITION_DELETE_FACES_BATCH);
      await this.call('DeleteFaces', (http) =>
        this.options.client.send(
          new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: batch }),
          http,
        ),
      );
    }
  }

  async listFaces(request: ListFacesRequest): Promise<ListFacesPage> {
    const out = await this.call('ListFaces', (http) =>
      this.options.client.send(
        new ListFacesCommand({
          CollectionId: request.collectionId,
          MaxResults: request.maxResults,
          NextToken: request.nextToken,
        }),
        http,
      ),
    );
    return {
      faces: (out.Faces ?? []).flatMap((face) =>
        face.FaceId ? [{ faceId: face.FaceId, externalImageId: face.ExternalImageId }] : [],
      ),
      nextToken: out.NextToken || undefined,
    };
  }

  /**
   * Each attempt, retries included, is a real call and takes its own token. The request timeout
   * starts after the token: waiting for a slot is bounded by the limiter's `maxWaitMs`.
   */
  private call<T>(
    operation: RekognitionOperation,
    send: (options: { abortSignal: AbortSignal }) => Promise<T>,
    isRetryable: (error: unknown) => boolean = isRetryableAwsError,
  ): Promise<T> {
    const limiter = this.options.limiters[operation];
    return withRetry(
      async () => {
        await limiter.acquire();
        return withRequestTimeout(operation, this.options.requestTimeoutMs, send);
      },
      isRetryable,
      this.options.retry,
    );
  }
}

/**
 * Runs one request with an abort signal and fails it with RekognitionRequestTimeoutError after
 * `timeoutMs`, whether or not the request reacts to the abort.
 */
async function withRequestTimeout<T>(
  operation: string,
  timeoutMs: number,
  send: (options: { abortSignal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RekognitionRequestTimeoutError(operation, timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    const request = send({ abortSignal: controller.signal });
    // After a timeout the aborted request rejects too; that rejection is expected.
    request.catch(() => undefined);
    return await Promise.race([request, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Rekognition rejects larger `Image.Bytes` with ImageTooLargeException; fail before the token. */
function assertInlineSize(bytes: Uint8Array): void {
  if (bytes.length > REKOGNITION_INLINE_MAX_BYTES) {
    throw new ImageTooLargeError(bytes.length, REKOGNITION_INLINE_MAX_BYTES);
  }
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
