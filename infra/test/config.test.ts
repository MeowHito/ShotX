import { TMP_LIFECYCLE_MAX_DAYS } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { facesQueueWorstCase, parseConfig, resolveRawConfig, zipLifetime } from '../lib/config';
import { CONTEXT_KEY } from '../lib/constants';
import { facesJobWorstCase, serviceFaceConfig } from '../lib/face-limits';
import {
  minReconcileExpirationDays,
  minZipExpirationDays,
  serviceShareConfig,
  serviceWorkerSettings,
  workerStopTimeoutSeconds,
  zipJobWorstCaseSeconds,
} from '../lib/worker-limits';
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

  it('rejects tmp/index/ expiry outside 1-3 days', () => {
    const c = withEdit((x) => {
      at(x, 'storage').tmpIndexExpirationDays = 5;
    });
    expect(() => parseConfig(c)).toThrow(/tmpIndexExpirationDays/);
  });

  describe('tmp/zips/ lifecycle', () => {
    const withZips = (days: number, env: Record<string, Record<string, string>> = {}) =>
      withEdit((x) => {
        at(x, 'storage').tmpZipsExpirationDays = days;
        for (const [group, vars] of Object.entries(env)) {
          Object.assign(at(x, 'services', 'env', group), vars);
        }
      });

    it('outlives ZIP_RESULT_TTL_SECONDS plus the zip cap and the last download URL', () => {
      // 7200 s zip cap + 86400 s TTL + 600 s download URL + 300 s expiry bucket = 94500 s > 1 day.
      const config = parseConfig(withZips(2));
      expect(zipLifetime(config).seconds).toBe(94_500);
      expect(minZipExpirationDays(zipLifetime(config))).toBe(2);
      expect(() => parseConfig(withZips(1))).toThrow(
        /must be >= 2 days: a zip may still be downloaded at age WORKER_ZIP_MAX_PROCESSING_SECONDS 7200s[\s\S]*at storage\.tmpZipsExpirationDays/,
      );
    });

    it('follows ZIP_RESULT_TTL_SECONDS from either api or worker', () => {
      // The 2-day maximum TTL: 7200 + 172800 + 600 + 300 = 180900 s -> 3 days.
      for (const group of ['backend', 'api', 'worker', 'common']) {
        const env = { [group]: { ZIP_RESULT_TTL_SECONDS: '172800' } };
        expect(() => parseConfig(withZips(2, env)), group).toThrow(/must be >= 3 days/);
        expect(() => parseConfig(withZips(3, env)), group).not.toThrow();
      }
    });

    it('follows the worker zip cap and the download URL settings', () => {
      // 7200 + 160000 + 900 = 168100 s -> 2 days; with an 11 h cap 200500 s -> 3 days.
      const ttl = { ZIP_RESULT_TTL_SECONDS: '160000' };
      expect(() => parseConfig(withZips(2, { backend: ttl }))).not.toThrow();
      expect(() =>
        parseConfig(
          withZips(2, { backend: ttl, worker: { WORKER_ZIP_MAX_PROCESSING_SECONDS: '39600' } }),
        ),
      ).toThrow(/must be >= 3 days[\s\S]*at storage\.tmpZipsExpirationDays/);
      expect(() =>
        parseConfig(
          withZips(2, {
            backend: {
              SIGNED_URL_VIEW_TTL_SECONDS: '604800',
              SIGNED_URL_DOWNLOAD_TTL_SECONDS: '86400',
            },
          }),
        ),
      ).toThrow(/must be >= 3 days/);
    });

    it('never needs more than 3 days: shared rejects a zip lifetime beyond the tmp/ ceiling', () => {
      // Every allowed setting fits a 3-day rule even at the 11 h worker cap (ADR 0006).
      const worst = {
        ZIP_RESULT_TTL_SECONDS: '172800',
        SIGNED_URL_VIEW_TTL_SECONDS: '604800',
        SIGNED_URL_DOWNLOAD_TTL_SECONDS: '45900',
        SIGNED_URL_EXPIRY_BUCKET_SECONDS: '900',
      };
      const config = parseConfig(
        withEdit((x) => {
          Object.assign(at(x, 'services', 'env', 'backend'), worst);
          Object.assign(at(x, 'services', 'env', 'worker'), {
            WORKER_ZIP_MAX_PROCESSING_SECONDS: '39600',
          });
          at(x, 'storage').tmpZipsExpirationDays = 3;
          at(x, 'queues', 'zip').retentionDays = 2;
        }),
      );
      expect(zipLifetime(config).seconds).toBe(TMP_LIFECYCLE_MAX_DAYS * 86_400);
      expect(minZipExpirationDays(zipLifetime(config))).toBe(TMP_LIFECYCLE_MAX_DAYS);
      // One second more is refused by loadShareConfig, before infra's own check.
      expect(() =>
        parseConfig(
          withZips(3, { backend: { ...worst, SIGNED_URL_DOWNLOAD_TTL_SECONDS: '45901' } }),
        ),
      ).toThrow(/tmp\/ lifecycle ceiling/);
      expect(() =>
        parseConfig(withZips(3, { backend: { ZIP_RESULT_TTL_SECONDS: '259200' } })),
      ).toThrow(/ZIP_RESULT_TTL_SECONDS/);
    });

    it('keeps the tmp/ catch-all at least as long as every per-prefix rule', () => {
      const c = withEdit((x) => {
        at(x, 'storage').tmpOtherExpirationDays = 2;
      });
      expect(() => parseConfig(c)).toThrow(/must be >= 3[\s\S]*at storage\.tmpOtherExpirationDays/);
    });
  });

  describe('tmp/ rules stay within the spec’s 1-3 days (ADR 0006)', () => {
    for (const key of [
      'tmpIndexExpirationDays',
      'tmpZipsExpirationDays',
      'tmpReconcileExpirationDays',
      'tmpOtherExpirationDays',
    ]) {
      it(`rejects storage.${key} above 3 days or below 1`, () => {
        for (const days of [0, 4, 7]) {
          const c = withEdit((x) => {
            at(x, 'storage')[key] = days;
          });
          expect(() => parseConfig(c), `${key}=${days}`).toThrow(new RegExp(key));
        }
      });
    }

    it('uses 1 day for tmp/index/, 2 for tmp/zips/ and 3 for tmp/reconcile/ and the rest', () => {
      expect(parseConfig(rawConfig()).storage).toMatchObject({
        tmpIndexExpirationDays: 1,
        tmpZipsExpirationDays: 2,
        tmpReconcileExpirationDays: 3,
        tmpOtherExpirationDays: 3,
      });
    });

    it('keeps reconciliation scans for one orphan grace plus one daily run', () => {
      const withReconcile = (days: number, grace?: string) =>
        withEdit((x) => {
          at(x, 'storage').tmpReconcileExpirationDays = days;
          if (grace !== undefined) at(x, 'services', 'env', 'worker').FACE_ORPHAN_GRACE_MS = grace;
        });
      // 3 h grace + 1 day -> 2 days.
      expect(minReconcileExpirationDays(10_800_000)).toBe(2);
      expect(() => parseConfig(withReconcile(1))).toThrow(
        /must be >= 2 days: a reconciliation scan[\s\S]*at storage\.tmpReconcileExpirationDays/,
      );
      expect(() => parseConfig(withReconcile(2))).not.toThrow();
      // The longest grace FACE_ORPHAN_GRACE_MS allows (1 day) still fits in 2 days.
      expect(minReconcileExpirationDays(86_400_000)).toBe(2);
      expect(() => parseConfig(withReconcile(2, '86400000'))).not.toThrow();
    });
  });

  describe('worker caps (WORKER_*_MAX_PROCESSING_SECONDS)', () => {
    const withWorker = (vars: Record<string, string>, edit: (x: Json) => void = () => {}) =>
      withEdit((x) => {
        Object.assign(at(x, 'services', 'env', 'worker'), vars);
        edit(x);
      });

    it('keeps the faces cap above the faces worst case (3960 s)', () => {
      expect(() =>
        parseConfig(withWorker({ WORKER_FACES_MAX_PROCESSING_SECONDS: '3960' })),
      ).not.toThrow();
      expect(() =>
        parseConfig(withWorker({ WORKER_FACES_MAX_PROCESSING_SECONDS: '3959' })),
      ).toThrow(
        /WORKER_FACES_MAX_PROCESSING_SECONDS \(3959\) must be >= the faces worst case of 3960s/,
      );
    });

    it('checks the faces retention against the cap, not only the worst case', () => {
      // 5 x (39600 s cap + 900 s) = 202500 s > 2 days; with the 3960 s worst case it would fit.
      const c = withWorker({ WORKER_FACES_MAX_PROCESSING_SECONDS: '39600' }, (x) => {
        at(x, 'queues', 'faces').retentionDays = 2;
      });
      expect(() => parseConfig(c)).toThrow(/queues\.faces\.retentionDays/);
    });

    it('sizes the zip worst case from ZIP_MAX_BYTES and keeps the zip cap above it', () => {
      // 2 GiB at 10 MiB/s = 204.8 s, plus 60 s = 265 s.
      const config = parseConfig(rawConfig());
      expect(
        zipJobWorstCaseSeconds(
          serviceShareConfig(config.services.env, 'worker'),
          config.queues.zip.jobBudget,
        ),
      ).toBe(265);
      expect(() => parseConfig(withWorker({ WORKER_ZIP_MAX_PROCESSING_SECONDS: '240' }))).toThrow(
        /WORKER_ZIP_MAX_PROCESSING_SECONDS \(240\) must be >= the zip worst case of 265s/,
      );
    });

    it('requires zip receives x timeout to cover the zip worst case', () => {
      // 3 x 60 s = 180 s < 265 s.
      const c = withEdit((x) => {
        at(x, 'queues', 'zip').visibilityTimeoutSeconds = 60;
      });
      expect(() => parseConfig(c)).toThrow(/queues\.zip\.visibilityTimeoutSeconds/);
    });

    it('checks every queue retention against its cap', () => {
      // zip: 3 x (39600 + 300) > 1 day. jobs: 3 x (39600 + 900) > 1 day. media: 5 x 39900 > 2 days.
      for (const [q, key, retention] of [
        ['zip', 'WORKER_ZIP_MAX_PROCESSING_SECONDS', 1],
        ['jobs', 'WORKER_JOB_MAX_RUNTIME_SECONDS', 1],
        ['media', 'WORKER_MEDIA_MAX_PROCESSING_SECONDS', 2],
      ] as const) {
        const c = withWorker({ [key]: '39600' }, (x) => {
          at(x, 'queues', q).retentionDays = retention;
        });
        expect(() => parseConfig(c), q).toThrow(new RegExp(`queues\\.${q}\\.retentionDays`));
      }
    });

    it('rejects WORKER_* values that loadWorkerSettings rejects', () => {
      expect(() => parseConfig(withWorker({ WORKER_ZIP_CONCURRENCY: '2' }))).toThrow(
        /worker: [\s\S]*WORKER_ZIP_CONCURRENCY/,
      );
    });
  });

  describe('worker stop timeout', () => {
    it('is WORKER_SHUTDOWN_GRACE_SECONDS plus the margin, at most 120 s', () => {
      const config = parseConfig(rawConfig());
      expect(
        workerStopTimeoutSeconds(
          serviceWorkerSettings(config.services.env),
          config.services.worker.stopTimeoutMarginSeconds,
        ),
      ).toBe(30);
      const c = (grace: string, margin: number) =>
        withEdit((x) => {
          at(x, 'services', 'env', 'worker').WORKER_SHUTDOWN_GRACE_SECONDS = grace;
          at(x, 'services', 'worker').stopTimeoutMarginSeconds = margin;
        });
      expect(() => parseConfig(c('110', 10))).not.toThrow();
      expect(() => parseConfig(c('110', 11))).toThrow(
        /= 121s exceeds the Fargate maximum stop timeout of 120s\n\s+→ at services\.worker$/m,
      );
    });
  });

  describe('services.env', () => {
    it('refuses keys infra sets from typed context or secrets', () => {
      for (const [group, key] of [
        ['backend', 'FACE_SEARCH_ENABLED'],
        ['api', 'CONSENT_POLICY_VERSION'],
        ['api', 'IP_HASH_SECRET'],
        ['web', 'MEDIA_BUCKET'],
      ] as const) {
        const c = withEdit((x) => {
          at(x, 'services', 'env', group)[key] = 'x'.repeat(40);
        });
        expect(() => parseConfig(c), key).toThrow(new RegExp(`${group}: ${key} is set by infra`));
      }
    });

    it('keeps upload settings in the common group so web and api agree', () => {
      for (const group of ['backend', 'web', 'api', 'worker']) {
        const c = withEdit((x) => {
          at(x, 'services', 'env', group).UPLOAD_PART_BYTES = '33554432';
        });
        expect(() => parseConfig(c), group).toThrow(
          /UPLOAD_PART_BYTES must be in services\.env\.common/,
        );
      }
      const common = withEdit((x) => {
        at(x, 'services', 'env', 'common').UPLOAD_PART_BYTES = '33554432';
      });
      expect(() => parseConfig(common)).not.toThrow();
      // api-only request limits (loadApiLimitsConfig) can stay with the api.
      const apiLimit = withEdit((x) => {
        at(x, 'services', 'env', 'api').UPLOAD_INIT_RATE_PER_USER = '100';
      });
      expect(() => parseConfig(apiLimit)).not.toThrow();
    });
  });

  it('only accepts a known consent policy version', () => {
    const c = withEdit((x) => {
      at(x, 'consent').policyVersion = '2099-01-01';
    });
    expect(() => parseConfig(c)).toThrow(/consent\.policyVersion/);
  });

  it('keeps response-content-disposition in the /media/* cache key', () => {
    const c = withEdit((x) => {
      at(x, 'cdn', 'media').cacheQueryStrings = [];
    });
    expect(() => parseConfig(c)).toThrow(
      /response-content-disposition[\s\S]*at cdn\.media\.cacheQueryStrings/,
    );
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
