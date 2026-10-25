import { describe, expect, it } from 'vitest';
import { facesQueueWorstCase, parseConfig, resolveRawConfig } from '../lib/config';
import { CONTEXT_KEY } from '../lib/constants';
import { facesJobWorstCase, serviceFaceConfig } from '../lib/face-limits';
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
      at(x, 'queues', 'faces').maxReceiveCount = 1000;
    });
    expect(() => parseConfig(c)).toThrow(/visibilityTimeoutSeconds/);
  });

  it('rejects a visibility timeout above the SQS maximum of 12 h', () => {
    const c = withEdit((x) => {
      at(x, 'queues', 'faces').visibilityTimeoutSeconds = 43_201;
    });
    expect(() => parseConfig(c)).toThrow(/visibilityTimeoutSeconds/);
  });

  it('rejects any queue timeout below 60 s (heartbeats every third of it)', () => {
    for (const q of ['media', 'zip', 'jobs']) {
      const c = withEdit((x) => {
        at(x, 'queues', q).visibilityTimeoutSeconds = 59;
      });
      expect(() => parseConfig(c), q).toThrow(
        new RegExp(`queues\\.${q}\\.visibilityTimeoutSeconds`),
      );
    }
  });

  describe('faces job worst case', () => {
    const config = parseConfig(rawConfig());
    // The arithmetic only: the worker's FACE_* values with `env` on top, no other validation.
    const worstWith = (env: Record<string, string>) =>
      facesJobWorstCase(
        serviceFaceConfig(
          { ...config.services.env, worker: { ...config.services.env.worker, ...env } },
          'worker',
        ),
        config.queues.faces.jobBudget,
      ).seconds;

    it('is 10 calls of 390 s plus 60 s at the defaults', () => {
      // per call: 8 x (30 s wait + 10 s request timeout) + 7 x 10 s backoff = 390 s
      // calls: 2 collection + 5 IndexFaces + 3 DeleteFaces (previous, cut-off, rollback) = 10
      expect(facesQueueWorstCase(parseConfig(rawConfig()))).toEqual({
        perCallSeconds: 390,
        collectionCalls: 2,
        indexFacesCalls: 5,
        deleteFacesCalls: 3,
        totalCalls: 10,
        processingSeconds: 60,
        seconds: 3960,
      });
    });

    it('counts FACE_REKOGNITION_REQUEST_TIMEOUT_MS once per attempt of every call', () => {
      // 10 s more per request: 10 calls x 8 attempts x 10 s.
      expect(worstWith({ FACE_REKOGNITION_REQUEST_TIMEOUT_MS: '20000' })).toBe(3960 + 800);
    });

    it('counts retry attempts, backoff and tiles', () => {
      const base = worstWith({});
      // One attempt fewer: 10 calls x (30 s wait + 10 s request + 10 s backoff).
      expect(worstWith({ FACE_REKOGNITION_MAX_ATTEMPTS: '7' })).toBe(base - 10 * 50);
      // Longer backoff cap: 10 calls x 7 retries x 5 s more.
      expect(worstWith({ FACE_REKOGNITION_RETRY_MAX_MS: '15000' })).toBe(base + 10 * 7 * 5);
      // A 3x3 grid: 10 IndexFaces instead of 5.
      expect(worstWith({ FACE_TILE_GRID: '3' })).toBe(base + 5 * 390);
    });
  });

  describe('faces queue heartbeat rules', () => {
    it('keeps the faces timeout between 600 and 900 s', () => {
      const t = parseConfig(rawConfig()).queues.faces.visibilityTimeoutSeconds;
      expect(t).toBeGreaterThanOrEqual(600);
      expect(t).toBeLessThanOrEqual(900);
    });

    it('requires maxReceiveCount x timeout to cover the worst case (5 x 792 s >= 3960 s)', () => {
      const withTimeout = (t: number) =>
        withEdit((x) => {
          at(x, 'queues', 'faces').visibilityTimeoutSeconds = t;
        });
      expect(() => parseConfig(withTimeout(792))).not.toThrow();
      expect(() => parseConfig(withTimeout(791))).toThrow(
        /maxReceiveCount × visibilityTimeoutSeconds \(5 × 791s = 3955s\) must cover the worst case of 3960s \(one faces job makes up to 10 Rekognition calls/,
      );
      // 600 s would need maxReceiveCount 7.
      expect(() => parseConfig(withTimeout(600))).toThrow(
        /queues\.faces\.visibilityTimeoutSeconds/,
      );
    });

    it('rejects a worst case beyond the 12 h cap that heartbeats cannot extend', () => {
      const c = withEdit((x) => {
        Object.assign(at(x, 'services', 'env', 'worker'), {
          FACE_REKOGNITION_MAX_WAIT_MS: '600000',
          FACE_REKOGNITION_MAX_ATTEMPTS: '20',
          FACE_ORPHAN_GRACE_MS: '86400000',
        });
        at(x, 'queues', 'faces').maxReceiveCount = 1000;
      });
      expect(() => parseConfig(c)).toThrow(/exceeds SQS's 12 h visibility cap/);
    });

    it('rejects a retention period that a failing message can outlive', () => {
      // 20 x (3960 s + 900 s) = 97,200 s > 1 day.
      const c = withEdit((x) => {
        Object.assign(at(x, 'queues', 'faces'), { maxReceiveCount: 20, retentionDays: 1 });
      });
      expect(() => parseConfig(c)).toThrow(/queues\.faces\.retentionDays/);
    });

    it('reads FACE_* the way the worker does: worker group over backend over common', () => {
      // 60 s waits: 8 x (60 + 10) + 70 = 630 s per call, 6360 s > 5 x 900 s.
      const c = withEdit((x) => {
        at(x, 'services', 'env', 'common').FACE_REKOGNITION_MAX_WAIT_MS = '1000';
        at(x, 'services', 'env', 'backend').FACE_REKOGNITION_MAX_WAIT_MS = '60000';
      });
      expect(() => parseConfig(c)).toThrow(/worst case of 6360s/);
      const workerWins = withEdit((x) => {
        at(x, 'services', 'env', 'backend').FACE_REKOGNITION_MAX_WAIT_MS = '60000';
        at(x, 'services', 'env', 'worker').FACE_REKOGNITION_MAX_WAIT_MS = '30000';
      });
      expect(() => parseConfig(workerWins)).not.toThrow();
    });
  });

  describe('FACE_ORPHAN_GRACE_MS', () => {
    const withGrace = (grace: string | undefined) =>
      withEdit((x) => {
        const backend = at(x, 'services', 'env', 'backend');
        if (grace === undefined) delete backend.FACE_ORPHAN_GRACE_MS;
        else backend.FACE_ORPHAN_GRACE_MS = grace;
      });

    it('must be at least twice the worst-case faces attempt (2 x 3960 s)', () => {
      expect(() => parseConfig(withGrace('7920000'))).not.toThrow();
      expect(() => parseConfig(withGrace('7919999'))).toThrow(
        /FACE_ORPHAN_GRACE_MS \(7919999\) must be >= 7920000, twice the longest faces attempt \(3960s/,
      );
    });

    it('accepts the 3 h code default and rejects an explicit 1 h with the default retry budget', () => {
      expect(() => parseConfig(withGrace(undefined))).not.toThrow();
      expect(() => parseConfig(withGrace('3600000'))).toThrow(/FACE_ORPHAN_GRACE_MS \(3600000\)/);
    });

    it('is checked for the worker, which indexes and reconciles', () => {
      const c = withEdit((x) => {
        at(x, 'services', 'env', 'worker').FACE_ORPHAN_GRACE_MS = '3600000';
      });
      expect(() => parseConfig(c)).toThrow(/worker: FACE_ORPHAN_GRACE_MS/);
    });
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

  it('requires the media CSP to allow only its own media, with CORS for the opaque origin', () => {
    const headers = (edit: (h: Json) => void) =>
      withEdit((x) => edit(at(x, 'cdn', 'media', 'responseHeaders')));
    expect(() =>
      parseConfig(
        headers((h) => {
          h.contentSecurityPolicy = "default-src 'none'; media-src *; sandbox";
        }),
      ),
    ).toThrow(/media-src may only be 'self'/);
    expect(() =>
      parseConfig(
        headers((h) => {
          h.corsAllowOrigins = [];
        }),
      ),
    ).toThrow(/corsAllowOrigins/);
    expect(() =>
      parseConfig(
        headers((h) => {
          h.corsAllowOrigins = ['null'];
        }),
      ),
    ).toThrow(/never "null"/);
    // Without media-src there is nothing to fetch, and CORS may be off.
    expect(() =>
      parseConfig(
        headers((h) => {
          h.contentSecurityPolicy = "default-src 'none'; sandbox";
          h.corsAllowOrigins = [];
        }),
      ),
    ).not.toThrow();
  });

  it('requires the Redis app user to deny @dangerous, with nothing allowed after it', () => {
    for (const rules of [
      'on ~* &* +@all',
      'on ~* &* -@dangerous +@all',
      'on ~* &* +@all -@dangerous +flushall',
      'on ~* &* +@all -@dangerous allcommands',
    ]) {
      const c = withEdit((x) => {
        at(x, 'redis').accessString = rules;
      });
      expect(() => parseConfig(c), rules).toThrow(/-@dangerous/);
    }
    const narrower = withEdit((x) => {
      at(x, 'redis').accessString = 'on ~* &* +@all -@dangerous -@pubsub';
    });
    expect(() => parseConfig(narrower)).not.toThrow();
  });

  it('keeps the Redis memory alarm threshold strictly between 0 and 100 %', () => {
    for (const threshold of [0, 100]) {
      const c = withEdit((x) => {
        at(x, 'redis', 'alarms').memoryUsagePercentThreshold = threshold;
      });
      expect(() => parseConfig(c), String(threshold)).toThrow(/memoryUsagePercentThreshold/);
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
