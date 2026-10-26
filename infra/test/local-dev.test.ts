import { loadAuthProviderConfig, loadMediaUrlSignerConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config';
import { rawConfig, synthPlatform } from './helpers';

type Json = Record<string, unknown>;

const at = (o: Json, ...path: string[]): Json => path.reduce((n, k) => n[k] as Json, o);
const withEdit = (edit: (c: Json) => void): Json => {
  const c = rawConfig();
  edit(c);
  return c;
};

const LOCAL_ONLY = {
  NODE_ENV: 'development',
  APP_STAGE: 'local',
  AUTH_PROVIDER: 'local',
  LOCAL_AUTH_SECRET: 'x'.repeat(40),
  MEDIA_URL_SIGNER: 's3-presign',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

describe('local development stand-ins never reach a deployed stage', () => {
  it('reserves the stage name local', () => {
    const c = withEdit((x) => {
      x.stage = 'local';
    });
    expect(() => parseConfig(c)).toThrow(/reserved for local development/);
  });

  for (const group of ['common', 'web', 'admin', 'backend', 'api', 'worker']) {
    it(`refuses the runtime and local-only keys in services.env.${group}`, () => {
      for (const [key, value] of Object.entries(LOCAL_ONLY)) {
        const c = withEdit((x) => {
          at(x, 'services', 'env')[group] = { [key]: value };
        });
        expect(() => parseConfig(c), key).toThrow(new RegExp(`${group}: ${key} is set by infra`));
      }
    });
  }

  it('gives every container NODE_ENV=production and resolves to Cognito and CloudFront', () => {
    const s = synthPlatform();
    const app = s.template(s.platform.app);
    const definitions = Object.values(app.findResources('AWS::ECS::TaskDefinition'));
    expect(definitions.length).toBeGreaterThan(0);
    for (const td of definitions) {
      // Every container, so a sidecar can't carry local-only settings either.
      for (const container of (td.Properties as Json).ContainerDefinitions as Json[]) {
        const env = Object.fromEntries(
          ((container.Environment ?? []) as { Name: string; Value: unknown }[]).map((e) => [
            e.Name,
            typeof e.Value === 'string' ? e.Value : 'token',
          ]),
        );
        expect(env.NODE_ENV).toBe('production');
        for (const key of ['AUTH_PROVIDER', 'LOCAL_AUTH_SECRET', 'MEDIA_URL_SIGNER']) {
          expect(env[key], key).toBeUndefined();
        }
        expect(loadAuthProviderConfig(env)).toEqual({ provider: 'cognito' });
        expect(loadMediaUrlSignerConfig(env)).toEqual({ signer: 'cloudfront' });
      }
    }
  });
});
