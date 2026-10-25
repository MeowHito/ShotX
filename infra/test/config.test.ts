import { describe, expect, it } from 'vitest';
import { facesQueueWorstCase, parseConfig, resolveRawConfig } from '../lib/config';
import { CONTEXT_KEY } from '../lib/constants';
import { rawConfig } from './helpers';

type Json = Record<string, unknown>;
const at = (o: Json, ...path: string[]): Json => path.reduce((n, k) => n[k] as Json, o);

function withEdit(edit: (c: Json) => void): Json {
  const c = rawConfig();
  edit(c);
  return c;
}

describe('cdk.json config', () => {
  it('parses', () => {
    const config = parseConfig(rawConfig());
    expect(config.stage).toBe('prod');
    expect(config.storage.abortIncompleteMultipartUploadDays).toBe(2);
  });

  it('rejects tmp/ expiry outside 1-3 days', () => {
    const c = withEdit((x) => {
      at(x, 'storage').tmpExpirationDays = 5;
    });
    expect(() => parseConfig(c)).toThrow(/tmpExpirationDays/);
  });

  it('rejects a faces visibility timeout below 180 s', () => {
    const c = withEdit((x) => {
      at(x, 'queues', 'faces').visibilityTimeoutSeconds = 170;
    });
    expect(() => parseConfig(c)).toThrow(/visibilityTimeoutSeconds/);
  });

  it('rejects a visibility timeout above the SQS maximum of 12 h', () => {
    const c = withEdit((x) => {
      at(x, 'queues', 'faces').visibilityTimeoutSeconds = 43_201;
    });
    expect(() => parseConfig(c)).toThrow(/visibilityTimeoutSeconds/);
  });

  it('sets the faces visibility timeout at or above the worst case of one faces job', () => {
    const config = parseConfig(rawConfig());
    const worst = facesQueueWorstCase(config);
    // 9 calls x [8 x (30 s wait + 10 s call) + 7 x 10 s backoff] + 60 s processing
    expect(worst).toMatchObject({
      perCallSeconds: 390,
      collectionCalls: 2,
      indexFacesCalls: 5,
      deleteFacesCalls: 2,
      totalCalls: 9,
      floorSeconds: 3570,
    });
    expect(config.queues.faces.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(worst.floorSeconds);
  });

  it('rejects a faces visibility timeout just below the worst case, and explains it', () => {
    const floor = facesQueueWorstCase(parseConfig(rawConfig())).floorSeconds;
    const below = withEdit((x) => {
      at(x, 'queues', 'faces').visibilityTimeoutSeconds = floor - 1;
    });
    expect(() => parseConfig(below)).toThrow(
      new RegExp(`>= ${floor}s: one faces job makes up to 9 Rekognition calls`),
    );
    const exact = withEdit((x) => {
      at(x, 'queues', 'faces').visibilityTimeoutSeconds = floor;
    });
    expect(() => parseConfig(exact)).not.toThrow();
  });

  it('counts retry attempts and backoff, not just one rate-limit wait per call', () => {
    const floorWith = (env: Json) =>
      facesQueueWorstCase(
        parseConfig(
          withEdit((x) => {
            Object.assign(at(x, 'services', 'env', 'worker'), env);
            at(x, 'queues', 'faces').visibilityTimeoutSeconds = 43_200;
          }),
        ),
      ).floorSeconds;
    const base = floorWith({});
    // One attempt fewer: 9 calls x (30 s + 10 s wait and call + 10 s backoff) less.
    expect(floorWith({ FACE_REKOGNITION_MAX_ATTEMPTS: '7' })).toBe(base - 9 * 50);
    // Longer backoff cap: 9 calls x 7 retries x 5 s more.
    expect(floorWith({ FACE_REKOGNITION_RETRY_MAX_MS: '15000' })).toBe(base + 9 * 7 * 5);
    // A 3x3 grid: 10 IndexFaces instead of 5.
    expect(floorWith({ FACE_TILE_GRID: '3' })).toBe(base + 5 * 390);
  });

  it('reads FACE_* the way the worker does: worker group over backend over common', () => {
    const c = withEdit((x) => {
      at(x, 'services', 'env', 'common').FACE_REKOGNITION_MAX_WAIT_MS = '1000';
      at(x, 'services', 'env', 'backend').FACE_REKOGNITION_MAX_WAIT_MS = '60000';
    });
    expect(() => parseConfig(c)).toThrow(/>= 5730s/);
    const workerWins = withEdit((x) => {
      at(x, 'services', 'env', 'backend').FACE_REKOGNITION_MAX_WAIT_MS = '60000';
      at(x, 'services', 'env', 'worker').FACE_REKOGNITION_MAX_WAIT_MS = '30000';
    });
    expect(() => parseConfig(workerWins)).not.toThrow();
  });

  it('rejects FACE_* values that loadFaceConfig rejects', () => {
    const c = withEdit((x) => {
      at(x, 'services', 'env', 'backend').FACE_TILE_GRID = '9';
    });
    expect(() => parseConfig(c)).toThrow(/FACE_TILE_GRID/);
  });

  it('requires a sandboxing CSP on /media/*', () => {
    for (const csp of [
      "default-src 'none'",
      "default-src 'self'; sandbox",
      "default-src 'none'; sandbox allow-scripts",
    ]) {
      const c = withEdit((x) => {
        at(x, 'cdn', 'media', 'responseHeaders').contentSecurityPolicy = csp;
      });
      expect(() => parseConfig(c), csp).toThrow(/contentSecurityPolicy/);
    }
  });

  it('refuses the default Redis user as the app user', () => {
    const c = withEdit((x) => {
      at(x, 'redis').username = 'default';
    });
    expect(() => parseConfig(c)).toThrow(/default user is disabled/);
  });

  it('refuses to let CloudFront read tmp/index/', () => {
    for (const prefix of ['tmp/', 'tmp/index/']) {
      const c = withEdit((x) => {
        at(x, 'cdn', 'media').readablePrefixes = ['derived/', prefix];
      });
      expect(() => parseConfig(c)).toThrow(/tmp\/index/);
    }
  });

  it('only accepts us-east-1 certificates for CloudFront', () => {
    const c = withEdit((x) => {
      at(x, 'domain').certificateArn =
        'arn:aws:acm:ap-southeast-1:123456789012:certificate/0f0e0d0c-0b0a-0908-0706-050403020100';
    });
    expect(() => parseConfig(c)).toThrow(/us-east-1/);
  });

  it('applies shotx:<path> overrides from the CLI', () => {
    const base = rawConfig();
    const context: Json = {
      [CONTEXT_KEY]: base,
      [`${CONTEXT_KEY}:services.imageTag`]: 'sha-abc123',
      [`${CONTEXT_KEY}:account`]: '123456789012',
      [`${CONTEXT_KEY}:waf.adminAllowedIpv4Cidrs`]: '["203.0.113.0/24"]',
      [`${CONTEXT_KEY}:services.worker.maxCapacity`]: '4',
      [`${CONTEXT_KEY}:cdn.flatRatePlan.enabled`]: 'false',
    };
    const config = parseConfig(resolveRawConfig((k) => context[k], Object.keys(context)));
    expect(config.services.imageTag).toBe('sha-abc123');
    expect(config.account).toBe('123456789012');
    expect(config.waf.adminAllowedIpv4Cidrs).toEqual(['203.0.113.0/24']);
    expect(config.services.worker.maxCapacity).toBe(4);
    expect(config.cdn.flatRatePlan.enabled).toBe(false);
    // The base object from cdk.json is not mutated.
    expect(at(base, 'services').imageTag).toBe('bootstrap');
  });
});
