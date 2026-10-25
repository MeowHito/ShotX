import { describe, expect, it } from 'vitest';
import { facesVisibilityFloorSeconds, parseConfig, resolveRawConfig } from '../lib/config';
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

  it('raises the faces visibility floor when FACE_REKOGNITION_MAX_WAIT_MS is raised', () => {
    const c = withEdit((x) => {
      at(x, 'services', 'env', 'backend').FACE_REKOGNITION_MAX_WAIT_MS = '60000';
    });
    // (1 + 2^2) x 60 s + 30 s processing margin
    expect(facesVisibilityFloorSeconds(parseConfig(rawConfig()).services.env)).toBe(180);
    expect(() => parseConfig(c)).toThrow(/>= 330s/);
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
