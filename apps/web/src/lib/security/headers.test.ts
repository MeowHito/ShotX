// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formActionOrigins, mediaOrigins, uploadOrigins } from '../server/config';
import { buildCsp, securityHeaders } from './headers';

function directives(csp: string): Record<string, string> {
  return Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name = '', ...rest] = d.split(' ');
      return [name, rest.join(' ')];
    }),
  );
}

describe('CSP', () => {
  const csp = directives(
    buildCsp({
      nonce: 'abc',
      isDev: false,
      https: true,
      publicBaseUrl: 'https://photos.example.com',
      uploadOrigins: ['https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com'],
      formActionOrigins: ['https://shotx-prod-auth.auth.ap-southeast-1.amazoncognito.com'],
    }),
  );

  it('allows media and images from the main origin only', () => {
    expect(csp['img-src']).toBe("'self' https://photos.example.com blob: data:");
    expect(csp['media-src']).toBe("'self' https://photos.example.com blob:");
  });

  it('allows uploads to the S3 origin and nothing else cross-origin', () => {
    expect(csp['connect-src']).toBe(
      "'self' https://photos.example.com https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com",
    );
  });

  it('uses the nonce for scripts and blocks framing', () => {
    expect(csp['script-src']).toBe("'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp['frame-ancestors']).toBe("'none'");
    expect(csp['object-src']).toBe("'none'");
    expect(csp['form-action']).toBe(
      "'self' https://shotx-prod-auth.auth.ap-southeast-1.amazoncognito.com",
    );
    expect('upgrade-insecure-requests' in csp).toBe(true);
  });

  it('allows wasm only where asked (share page face detector), never a CDN', () => {
    expect(csp['script-src']).not.toContain('wasm-unsafe-eval');
    const share = directives(
      buildCsp({
        nonce: 'abc',
        isDev: false,
        https: true,
        publicBaseUrl: 'https://photos.example.com',
        uploadOrigins: [],
        allowWasm: true,
      }),
    );
    expect(share['script-src']).toBe("'self' 'nonce-abc' 'strict-dynamic' 'wasm-unsafe-eval'");
    // Model and wasm are fetched from the main origin; the detector runs on the main thread.
    expect(share['connect-src']).toBe("'self' https://photos.example.com");
    expect(share['worker-src']).toBe("'self' blob:");
    expect(share['img-src']).toBe("'self' https://photos.example.com blob: data:");
    expect(share['media-src']).toBe("'self' https://photos.example.com blob:");
    for (const value of Object.values(share)) expect(value).not.toMatch(/cdn|jsdelivr|googleapis/);
  });

  it('upgrades insecure requests only over https', () => {
    const plain = buildCsp({ nonce: 'n', isDev: false, https: false, uploadOrigins: [] });
    expect(plain).not.toContain('upgrade-insecure-requests');
  });

  it('adds HSTS only over https', () => {
    expect(securityHeaders('x', true)['Strict-Transport-Security']).toBeDefined();
    expect(securityHeaders('x', false)['Strict-Transport-Security']).toBeUndefined();
  });

  it('derives upload origins from the bucket, region and LocalStack endpoint', () => {
    expect(uploadOrigins({ MEDIA_BUCKET: 'shotx-prod-media' })).toEqual([
      'https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com',
    ]);
    expect(uploadOrigins({})).toEqual(['https://*.s3.ap-southeast-1.amazonaws.com']);
    expect(
      uploadOrigins({ AWS_ENDPOINT_URL: 'http://localhost:4566', MEDIA_BUCKET: 'b-1' }),
    ).toEqual(['https://b-1.s3.ap-southeast-1.amazonaws.com', 'http://localhost:4566']);
  });
});

describe('form-action', () => {
  const cognitoDomain = 'https://shotx-prod-auth.auth.ap-southeast-1.amazoncognito.com/';

  it('adds the Cognito domain only with AUTH_PROVIDER=cognito (the logout redirect)', () => {
    expect(formActionOrigins({ COGNITO_DOMAIN: cognitoDomain })).toEqual([
      'https://shotx-prod-auth.auth.ap-southeast-1.amazoncognito.com',
    ]);
    expect(formActionOrigins({ AUTH_PROVIDER: 'cognito' })).toEqual([]);
  });

  it('allows no other origin with API-issued tokens: LINE and Google are reached by links', () => {
    expect(
      formActionOrigins({ AUTH_PROVIDER: 'shotx', COGNITO_DOMAIN: cognitoDomain }),
    ).toEqual([]);
    const csp = directives(
      buildCsp({ nonce: 'n', isDev: false, https: true, uploadOrigins: [], formActionOrigins: [] }),
    );
    expect(csp['form-action']).toBe("'self'");
    for (const value of Object.values(csp)) {
      expect(value).not.toMatch(/line\.me|accounts\.google\.com|amazoncognito/);
    }
  });
});

describe('local media origins', () => {
  const local = {
    APP_STAGE: 'local',
    NODE_ENV: 'development',
    MEDIA_URL_SIGNER: 's3-presign',
    AWS_REGION: 'ap-southeast-1',
    AWS_ENDPOINT_URL: 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  };

  it('adds the LocalStack origin to img-src and media-src only with s3-presign', () => {
    expect(mediaOrigins({ AWS_REGION: 'ap-southeast-1' })).toEqual([]);
    const origins = mediaOrigins(local);
    expect(origins).toEqual(['http://localhost:4566']);
    const csp = buildCsp({
      nonce: 'n',
      isDev: true,
      https: false,
      uploadOrigins: [],
      mediaOrigins: origins,
    });
    expect(csp).toMatch(/img-src [^;]*http:\/\/localhost:4566/);
    expect(csp).toMatch(/media-src [^;]*http:\/\/localhost:4566/);
  });

  it('refuses s3-presign outside APP_STAGE=local', () => {
    expect(() => mediaOrigins({ ...local, APP_STAGE: 'prod', NODE_ENV: 'production' })).toThrow(
      /needs APP_STAGE=local/,
    );
  });
});
