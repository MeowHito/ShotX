import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { faceSearchLimits, parseConfig } from '../lib/config';
import { QUEUE_NAMES } from '../lib/constants';
import { rawConfig } from './helpers';

/** Repository wiring infra owns outside infra/: CI services and Turborepo env pass-through. */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('CI', () => {
  const ci = read('.github/workflows/ci.yml');
  const checks = ci.slice(ci.indexOf('\n  checks:'), ci.indexOf('\n  synth:'));

  it('runs PostgreSQL 18 for the packages/db integration tests', () => {
    expect(checks).toMatch(/^\s{6}postgres:\n\s{8}image: postgres:18-alpine$/m);
    expect(checks).toMatch(/--health-cmd "pg_isready/);
    expect(checks).toMatch(
      /^\s{6}TEST_DATABASE_URL: postgres:\/\/shotx:shotx@localhost:5432\/shotx_test$/m,
    );
    expect(checks).toMatch(/POSTGRES_DB: shotx_test/);
  });

  it('runs Redis for the rate-limiter tests', () => {
    expect(checks).toMatch(/image: redis:7\.2-alpine/);
    expect(checks).toMatch(/REDIS_URL: redis:\/\/localhost:6379/);
  });
});

describe('.env.example', () => {
  const env = Object.fromEntries(
    read('.env.example')
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const config = parseConfig(rawConfig());

  it('lists the Redis credentials, empty for local Redis without AUTH', () => {
    expect(env.REDIS_URL).toMatch(/^redis:\/\/localhost:\d+$/);
    expect(env.REDIS_USERNAME).toBe('');
    expect(env.REDIS_PASSWORD).toBe('');
  });

  it('matches the derived face-search limits and queue visibility timeouts', () => {
    const limits = faceSearchLimits(config);
    expect(env.FACE_SEARCH_MAX_SELFIE_BYTES).toBe(String(limits.selfieMaxBytes));
    expect(env.FACE_SEARCH_MAX_BODY_BYTES).toBe(String(limits.maxBodyBytes));
    for (const q of QUEUE_NAMES) {
      expect(env[`${q.toUpperCase()}_QUEUE_VISIBILITY_TIMEOUT_SECONDS`], q).toBe(
        String(config.queues[q].visibilityTimeoutSeconds),
      );
    }
  });
});

describe('Turborepo', () => {
  it('passes TEST_DATABASE_URL through to test tasks', () => {
    const turbo = JSON.parse(read('turbo.json')) as {
      tasks: { test: { passThroughEnv: string[] } };
    };
    expect(turbo.tasks.test.passThroughEnv).toContain('TEST_DATABASE_URL');
  });
});
