import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ListFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { loadFaceConfig } from '@shotx/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexFacesOutcomeUnknownError } from './provider';
import { type RekognitionLimiters, REKOGNITION_OPERATIONS } from './rekognition-limits';
import {
  RekognitionFaceProvider,
  rekognitionClientConfig,
  RekognitionRequestTimeoutError,
  rekognitionRetryOptions,
} from './rekognition-provider';

// The smallest request timeout FaceConfig allows, so these tests use a config-producible value.
const config = loadFaceConfig({ FACE_REKOGNITION_REQUEST_TIMEOUT_MS: '1000' }).rekognition;
const TIMEOUT_MS = config.requestTimeoutMs;
/** Slack for timers and the local server; a hung request without a timeout never finishes. */
const SLACK_MS = 1500;

const openLimiters = Object.fromEntries(
  REKOGNITION_OPERATIONS.map((op) => [op, { acquire: () => Promise.resolve() }]),
) as unknown as RekognitionLimiters;

const indexRequest = {
  collectionId: 'pg-1',
  image: { bytes: new Uint8Array([1, 2, 3]) },
  externalImageId: 'file-1',
  maxFaces: 100,
  qualityFilter: 'LOW' as const,
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('request timeout with a stub client', () => {
  /** A client whose requests never finish unless aborted, recording each abort signal. */
  function hangingClient() {
    const signals: AbortSignal[] = [];
    const send = vi.fn((_command: unknown, options?: { abortSignal?: AbortSignal }) => {
      signals.push(options!.abortSignal!);
      return new Promise<never>(() => undefined);
    });
    return { client: { send } as unknown as RekognitionClient, send, signals };
  }

  function provider(client: RekognitionClient) {
    return new RekognitionFaceProvider({
      client,
      limiters: openLimiters,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() },
      requestTimeoutMs: 20,
    });
  }

  it('turns a hung IndexFaces into IndexFacesOutcomeUnknownError without retrying', async () => {
    const { client, send, signals } = hangingClient();
    const error = await rejection(provider(client).indexFaces(indexRequest));
    expect(error).toBeInstanceOf(IndexFacesOutcomeUnknownError);
    expect((error as Error).cause).toBeInstanceOf(RekognitionRequestTimeoutError);
    expect((error as Error).cause).toMatchObject({ name: 'TimeoutError', timeoutMs: 20 });
    expect(send).toHaveBeenCalledTimes(1);
    // The request was aborted, so the SDK closes its socket.
    expect(signals[0]!.aborted).toBe(true);
  });

  it('retries a hung call that is safe to repeat, each attempt with its own timeout', async () => {
    const { client, send, signals } = hangingClient();
    const error = await rejection(
      provider(client).searchFaces({
        collectionId: 'pg-1',
        faceId: 'f',
        threshold: 85,
        maxFaces: 9,
      }),
    );
    expect(error).toBeInstanceOf(RekognitionRequestTimeoutError);
    expect(send).toHaveBeenCalledTimes(3);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
    expect(new Set(signals).size).toBe(3);
  });

  it('leaves requests that finish in time alone', async () => {
    const send = vi.fn((_command: unknown, options?: { abortSignal?: AbortSignal }) => {
      expect(options?.abortSignal?.aborted).toBe(false);
      return Promise.resolve({ FaceMatches: [] });
    });
    const p = provider({ send } as unknown as RekognitionClient);
    await expect(
      p.searchFaces({ collectionId: 'pg-1', faceId: 'f', threshold: 85, maxFaces: 9 }),
    ).resolves.toEqual([]);
    const signal = send.mock.calls[0]![1]!.abortSignal!;
    // The timer is cleared: the signal stays unaborted after the timeout would have fired.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signal.aborted).toBe(false);
  });
});

describe('rekognitionClientConfig', () => {
  it('bounds connecting and each request by FACE_REKOGNITION_REQUEST_TIMEOUT_MS', () => {
    const defaults = loadFaceConfig({}).rekognition;
    expect(rekognitionClientConfig(defaults)).toEqual({
      region: 'ap-southeast-1',
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 10_000,
        requestTimeout: 10_000,
        throwOnRequestTimeout: true,
      },
    });
  });
});

/**
 * A local server standing in for Rekognition, so the real SDK client and its request handler are
 * exercised. Nothing leaves the machine: the endpoint is 127.0.0.1 and the credentials are fake.
 */
describe('request timeout against a local server that never answers', () => {
  let server: Server | undefined;
  let requests = 0;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    requests = 0;
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    server = createServer((req, res) => {
      requests++;
      handler(req, res);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new RekognitionClient({
      ...rekognitionClientConfig(config),
      endpoint: `http://127.0.0.1:${port}`,
      credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' },
    });
  }

  const neverRespond = () => undefined;

  function localProvider(client: RekognitionClient) {
    return new RekognitionFaceProvider({
      client,
      limiters: openLimiters,
      retry: rekognitionRetryOptions(config, 'background'),
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  it('fails IndexFaces with IndexFacesOutcomeUnknownError after the timeout, sent once', async () => {
    const client = await listen(neverRespond);
    const started = Date.now();
    const error = await rejection(localProvider(client).indexFaces(indexRequest));
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(IndexFacesOutcomeUnknownError);
    expect(((error as Error).cause as Error).name).toBe('TimeoutError');
    expect(requests).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  });

  it('makes the SDK handler itself fail a request that gets no response', async () => {
    const client = await listen(neverRespond);
    const started = Date.now();
    const error = await rejection(
      client.send(new ListFacesCommand({ CollectionId: 'pg-1', MaxResults: 1 })),
    );
    expect((error as Error).name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  });

  // The handler's request timeout stops once the response headers arrive; the provider's own
  // timeout also covers a body that never completes.
  it('times out a response whose body stalls after the headers', async () => {
    const client = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1', 'content-length': '64' });
      res.write('{"Faces":[');
    });
    const p = new RekognitionFaceProvider({
      client,
      limiters: openLimiters,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      requestTimeoutMs: config.requestTimeoutMs,
    });
    const started = Date.now();
    const error = await rejection(p.listFaces({ collectionId: 'pg-1', maxResults: 1 }));
    expect(error).toBeInstanceOf(RekognitionRequestTimeoutError);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  });
});
