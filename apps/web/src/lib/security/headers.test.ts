// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyticsId, captchaCsp, formActionOrigins, mediaBrowserOrigins } from '../server/config';
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

  it('derives AWS upload origins from the bucket, region and LocalStack endpoint', () => {
    expect(mediaBrowserOrigins({ MEDIA_BUCKET: 'shotx-prod-media' }).upload).toEqual([
      'https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com',
    ]);
    expect(mediaBrowserOrigins({}).upload).toEqual(['https://*.s3.ap-southeast-1.amazonaws.com']);
    expect(
      mediaBrowserOrigins({ AWS_ENDPOINT_URL: 'http://localhost:4566', MEDIA_BUCKET: 'b-1' })
        .upload,
    ).toEqual(['https://b-1.s3.ap-southeast-1.amazonaws.com', 'http://localhost:4566']);
  });
});

describe('Turnstile (share pages, CAPTCHA_PROVIDER=turnstile)', () => {
  const turnstileEnv = {
    APP_STAGE: 'prod',
    NODE_ENV: 'production',
    CAPTCHA_PROVIDER: 'turnstile',
    TURNSTILE_SITE_KEY: '0x4AAAAAAABkMYinukE8nzYS',
  };
  const shareCsp = (captcha = captchaCsp(turnstileEnv)) =>
    directives(
      buildCsp({
        nonce: 'abc',
        isDev: false,
        https: true,
        uploadOrigins: [],
        allowWasm: true,
        captcha,
      }),
    );

  it('adds challenges.cloudflare.com to script-src and frame-src, keeping nonce and strict-dynamic', () => {
    const d = shareCsp();
    expect(d['script-src']).toBe(
      "'self' 'nonce-abc' 'strict-dynamic' https://challenges.cloudflare.com 'wasm-unsafe-eval'",
    );
    expect(d['frame-src']).toBe("'self' https://challenges.cloudflare.com");
    // The widget talks to Cloudflare from its own iframe.
    expect(d['connect-src']).toBe("'self'");
    expect(d['frame-ancestors']).toBe("'none'");
  });

  it('adds nothing with waf or none, and no frame-src at all', () => {
    for (const provider of ['waf', 'none']) {
      const d = shareCsp(captchaCsp({ APP_STAGE: 'local', CAPTCHA_PROVIDER: provider }));
      expect(d['script-src']).toBe("'self' 'nonce-abc' 'strict-dynamic' 'wasm-unsafe-eval'");
      expect('frame-src' in d).toBe(false);
    }
  });

  it('refuses turnstile without a site key', () => {
    expect(() => captchaCsp({ ...turnstileEnv, TURNSTILE_SITE_KEY: undefined })).toThrow(
      /TURNSTILE_SITE_KEY/,
    );
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
    expect(formActionOrigins({ AUTH_PROVIDER: 'shotx', COGNITO_DOMAIN: cognitoDomain })).toEqual(
      [],
    );
    const csp = directives(
      buildCsp({ nonce: 'n', isDev: false, https: true, uploadOrigins: [], formActionOrigins: [] }),
    );
    expect(csp['form-action']).toBe("'self'");
    for (const value of Object.values(csp)) {
      expect(value).not.toMatch(/line\.me|accounts\.google\.com|amazoncognito/);
    }
  });
});

describe('storage origins', () => {
  const R2 = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
  const r2 = {
    APP_STAGE: 'prod',
    NODE_ENV: 'production',
    MEDIA_URL_SIGNER: 's3-presign',
    STORAGE_ENDPOINT_URL: R2,
    STORAGE_REGION: 'auto',
    S3_FORCE_PATH_STYLE: 'true',
    MEDIA_BUCKET: 'shotx-prod-media',
  };
  const csp = (origins: { upload: string[]; media: string[] }) =>
    directives(
      buildCsp({
        nonce: 'n',
        isDev: false,
        https: true,
        publicBaseUrl: 'https://photos.example.com',
        uploadOrigins: origins.upload,
        mediaOrigins: origins.media,
      }),
    );

  it('R2 (s3-presign on any stage): the endpoint for uploads, views, video and share fetches', () => {
    // Read without storage keys: web never has them.
    const origins = mediaBrowserOrigins(r2);
    expect(origins).toEqual({ upload: [R2], media: [R2] });
    const d = csp(origins);
    expect(d['img-src']).toBe(`'self' https://photos.example.com ${R2} blob: data:`);
    expect(d['media-src']).toBe(`'self' https://photos.example.com ${R2} blob:`);
    // Once, although it is both the upload and the media origin.
    expect(d['connect-src']).toBe(`'self' https://photos.example.com ${R2}`);
  });

  it('R2 virtual-hosted: uploads go to the bucket host, signed URLs stay path-style', () => {
    const origins = mediaBrowserOrigins({ ...r2, S3_FORCE_PATH_STYLE: 'false' });
    expect(origins.upload).toEqual([
      'https://shotx-prod-media.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    ]);
    expect(origins.media).toEqual([R2]);
    expect(csp(origins)['connect-src']).toBe(
      `'self' https://photos.example.com ${origins.upload[0]} ${R2}`,
    );
  });

  it('cloudfront: media is same-origin /media, so no extra origin anywhere but uploads', () => {
    const origins = mediaBrowserOrigins({ MEDIA_BUCKET: 'shotx-prod-media' });
    expect(origins.media).toEqual([]);
    const d = csp(origins);
    expect(d['img-src']).toBe("'self' https://photos.example.com blob: data:");
    expect(d['media-src']).toBe("'self' https://photos.example.com blob:");
    expect(d['connect-src']).toBe(
      "'self' https://photos.example.com https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com",
    );
  });

  it('local: LocalStack as the storage endpoint over http', () => {
    const origins = mediaBrowserOrigins({
      APP_STAGE: 'local',
      NODE_ENV: 'development',
      MEDIA_URL_SIGNER: 's3-presign',
      STORAGE_ENDPOINT_URL: 'http://localhost:4566',
      STORAGE_REGION: 'ap-southeast-1',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(origins).toEqual({
      upload: ['http://localhost:4566'],
      media: ['http://localhost:4566'],
    });
  });

  it('refuses s3-presign without an endpoint, and a private or plain-http endpoint outside local', () => {
    expect(() => mediaBrowserOrigins({ MEDIA_URL_SIGNER: 's3-presign' })).toThrow(
      /STORAGE_ENDPOINT_URL/,
    );
    expect(() =>
      mediaBrowserOrigins({ ...r2, STORAGE_ENDPOINT_URL: 'http://localhost:4566' }),
    ).toThrow(/STORAGE_ENDPOINT_URL must not be a localhost/);
    expect(() =>
      mediaBrowserOrigins({ ...r2, STORAGE_ENDPOINT_URL: 'http://r2.example.com' }),
    ).toThrow(/must be https/);
  });
});

describe('Google Analytics (GA_MEASUREMENT_ID, ADR 0017)', () => {
  const base = { nonce: 'n0nce', isDev: false, https: true, uploadOrigins: [] };
  const directive = (csp: string, name: string) =>
    csp
      .split('; ')
      .find((d) => d.startsWith(`${name} `))
      ?.split(' ')
      .slice(1) ?? [];

  it('adds Google’s GA4 sources only when analytics is on', () => {
    const on = buildCsp({ ...base, analytics: true });
    expect(directive(on, 'script-src')).toContain('https://www.googletagmanager.com');
    expect(directive(on, 'connect-src')).toEqual(
      expect.arrayContaining([
        'https://*.google-analytics.com',
        'https://*.analytics.google.com',
        'https://*.googletagmanager.com',
      ]),
    );
    expect(directive(on, 'img-src')).toContain('https://*.google-analytics.com');
    const off = buildCsp(base);
    expect(off).not.toContain('google');
  });

  it('reads the measurement id, off when unset, and refuses a malformed one', () => {
    expect(analyticsId({ GA_MEASUREMENT_ID: 'G-YK90K2DDPX' })).toBe('G-YK90K2DDPX');
    expect(analyticsId({ GA_MEASUREMENT_ID: '  G-YK90K2DDPX ' })).toBe('G-YK90K2DDPX');
    expect(analyticsId({})).toBeNull();
    expect(analyticsId({ GA_MEASUREMENT_ID: '' })).toBeNull();
    for (const bad of ['UA-12345-1', 'G-x', "G-1');alert(1)//"]) {
      expect(() => analyticsId({ GA_MEASUREMENT_ID: bad }), bad).toThrow(/GA_MEASUREMENT_ID/);
    }
  });
});
