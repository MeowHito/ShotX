import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RekognitionClient } from '@aws-sdk/client-rekognition';
import { type Env, loadFaceConfig, loadRekognitionClientConfig } from '@shotx/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RekognitionLimiters, REKOGNITION_OPERATIONS } from './rekognition-limits';
import {
  RekognitionFaceProvider,
  rekognitionClientConfig,
  rekognitionSdkConfig,
} from './rekognition-provider';

const config = loadFaceConfig({}).rekognition;

const openLimiters = Object.fromEntries(
  REKOGNITION_OPERATIONS.map((op) => [op, { acquire: () => Promise.resolve() }]),
) as unknown as RekognitionLimiters;

/** Explicit settings as in local development (LocalStack-style endpoint and keys). */
function explicitEnv(endpoint: string): Env {
  return {
    APP_STAGE: 'local',
    AUTH_PROVIDER: 'local',
    REKOGNITION_REGION: 'ap-southeast-1',
    REKOGNITION_ENDPOINT_URL: endpoint,
    REKOGNITION_ACCESS_KEY_ID: 'local-test',
    REKOGNITION_SECRET_ACCESS_KEY: 'local-test-secret',
  };
}

function clientOf(provider: RekognitionFaceProvider): RekognitionClient {
  return (provider as unknown as { options: { client: RekognitionClient } }).options.client;
}

describe('rekognitionSdkConfig', () => {
  it('sets the configured endpoint and credentials', () => {
    const client = loadRekognitionClientConfig(explicitEnv('http://127.0.0.1:4566'));
    expect(rekognitionSdkConfig(config, client)).toEqual({
      ...rekognitionClientConfig(config),
      region: 'ap-southeast-1',
      endpoint: 'http://127.0.0.1:4566',
      credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test-secret' },
    });
  });

  it('sets neither when none is configured (the AWS stacks: regional endpoint, task role)', () => {
    const client = loadRekognitionClientConfig({ REKOGNITION_REGION: 'ap-southeast-1' });
    expect(client).toEqual({ region: 'ap-southeast-1', endpointUrl: null, credentials: null });
    const sdk = rekognitionSdkConfig(config, client);
    expect(sdk).toEqual({ ...rekognitionClientConfig(config), region: 'ap-southeast-1' });
    expect(sdk).not.toHaveProperty('endpoint');
    expect(sdk).not.toHaveProperty('credentials');
  });

  it('takes the region from the client config', () => {
    const client = loadRekognitionClientConfig({ REKOGNITION_REGION: 'us-east-1' });
    expect(rekognitionSdkConfig(config, client).region).toBe('us-east-1');
  });
});

/** A local server standing in for Rekognition; nothing leaves the machine. */
describe('RekognitionFaceProvider.create', () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    const running = server;
    server = undefined;
    if (!running) return;
    running.closeAllConnections();
    await new Promise((resolve) => running.close(resolve));
  });

  async function listen(): Promise<{
    url: string;
    requests: Array<{ headers: IncomingHttpHeaders; body: string }>;
  }> {
    const requests: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        requests.push({ headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        res.end('{"FaceRecords":[],"UnindexedFaces":[]}');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests };
  }

  it('sends to the configured endpoint, signed with the configured keys, image as bytes', async () => {
    const { url, requests } = await listen();
    // AWS SDK v3 would apply this to a client without an explicit endpoint (ADR 0008 section 1).
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://127.0.0.1:9');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AMBIENTKEYNOTUSED');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-secret');
    const provider = RekognitionFaceProvider.create(
      config,
      'background',
      openLimiters,
      loadRekognitionClientConfig(explicitEnv(url)),
    );
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await expect(
      provider.indexFaces({
        collectionId: 'pg-1',
        image: { bytes },
        externalImageId: 'file-1',
        maxFaces: 100,
        qualityFilter: 'LOW',
      }),
    ).resolves.toEqual({ faces: [], unindexed: [] });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.headers['x-amz-target']).toBe('RekognitionService.IndexFaces');
    expect(request!.headers.authorization).toContain('Credential=local-test/');
    expect(request!.headers.authorization).toContain('/ap-southeast-1/rekognition/');
    const body = JSON.parse(request!.body) as { Image: Record<string, unknown> };
    expect(body.Image).toEqual({ Bytes: Buffer.from(bytes).toString('base64') });
  });

  it('builds a client on the regional endpoint when no endpoint is configured', async () => {
    const provider = RekognitionFaceProvider.create(
      config,
      'interactive',
      openLimiters,
      loadRekognitionClientConfig({}),
    );
    const sdk = clientOf(provider).config;
    expect(sdk.isCustomEndpoint).toBe(false);
    expect(await sdk.region()).toBe('ap-southeast-1');
  });
});
