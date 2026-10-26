import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LOCAL_AUTH_AUDIENCE, LOCAL_AUTH_ISSUER } from '@shotx/shared';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { CloudFrontMediaUrlSigner } from '../infra/cloudfront-signer';
import { S3PresignMediaUrlSigner } from '../infra/s3-presign-signer';
import { testConfig } from '../testing/fakes';
import { mediaUrlSigner, tokenVerifier } from '../wiring';
// The web app's local provider mints the tokens this verifier accepts: test the real handoff.
import { createLocalAuthProvider, issueLocalCode } from '../../../web/src/lib/auth/local';
import { createPkcePair } from '../../../web/src/lib/auth/pkce';
import { CognitoTokenVerifier } from './cognito-verifier';
import { LocalTokenVerifier } from './local-verifier';

const SECRET = 'local-test-secret-0123456789abcdef';

function token(
  claims: Record<string, unknown> = {},
  options: { secret?: string; issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({
    token_use: 'access',
    email: 'a@shotx.test',
    email_verified: true,
    name: 'A',
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('sub-1')
    .setIssuer(options.issuer ?? LOCAL_AUTH_ISSUER)
    .setAudience(options.audience ?? LOCAL_AUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

describe('LocalTokenVerifier', () => {
  const verifier = new LocalTokenVerifier(SECRET);

  it('accepts local tokens as users-pool identities with their profile', async () => {
    await expect(verifier.verify(await token())).resolves.toEqual({
      pool: 'users',
      sub: 'sub-1',
      tokenUse: 'access',
      email: 'a@shotx.test',
      name: 'A',
    });
  });

  it('rejects other secrets, issuers, audiences, expired tokens and bad token_use', async () => {
    const bad = [
      await token({}, { secret: 'another-secret-0123456789abcdefgh' }),
      await token({}, { issuer: 'https://cognito-idp.ap-southeast-1.amazonaws.com/x' }),
      await token({}, { audience: 'other' }),
      await token({}, { expiresIn: '-1m' }),
      await token({ token_use: 'refresh' }),
      'not-a-jwt',
    ];
    for (const t of bad) {
      await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });
});

describe('S3PresignMediaUrlSigner', () => {
  const now = new Date('2026-10-26T01:02:03Z');
  const options = {
    endpointUrl: 'http://localhost:4566',
    region: 'ap-southeast-1',
    bucket: 'shotx-local-media',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    now: () => now,
  };
  const key =
    'derived/0199b2a0-0000-7000-8000-000000000001/0199b2a0-0000-7000-8000-000000000002/thumb.webp';

  function sdkClient(): S3Client {
    const client = new S3Client({
      region: options.region,
      endpoint: options.endpointUrl,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    // The SDK adds `x-id=GetObject` before signing; media URLs don't carry it.
    client.middlewareStack.add(
      (next) => (args) => {
        const request = args.request as { query?: Record<string, unknown> };
        delete request.query?.['x-id'];
        return next(args);
      },
      { step: 'build' },
    );
    return client;
  }

  it('signs exactly like the AWS SDK presigner', async () => {
    const signer = new S3PresignMediaUrlSigner(options);
    const disposition = 'attachment; filename="รูป 1.jpg"';
    const ours = new URL(
      signer.sign(key, new Date(now.getTime() + 600_000), { contentDisposition: disposition }),
    );
    const client = sdkClient();
    const sdk = new URL(
      await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: options.bucket,
          Key: key,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: 600, signingDate: now },
      ),
    );
    expect(ours.pathname).toBe(sdk.pathname);
    expect(ours.searchParams.get('X-Amz-Signature')).toBe(sdk.searchParams.get('X-Amz-Signature'));
  });

  it('encodes non-ASCII and reserved characters in the key like the SDK', async () => {
    const thaiKey =
      "originals/0199b2a0-0000-7000-8000-000000000001/0199b2a0-0000-7000-8000-000000000002/รูป (1)!'.jpg";
    const signer = new S3PresignMediaUrlSigner(options);
    const ours = new URL(signer.sign(thaiKey, new Date(now.getTime() + 600_000)));
    const sdk = new URL(
      await getSignedUrl(
        sdkClient(),
        new GetObjectCommand({ Bucket: options.bucket, Key: thaiKey }),
        {
          expiresIn: 600,
          signingDate: now,
        },
      ),
    );
    expect(ours.pathname).toBe(sdk.pathname);
    expect(ours.searchParams.get('X-Amz-Signature')).toBe(sdk.searchParams.get('X-Amz-Signature'));
  });

  it('refuses keys the platform did not build', () => {
    const signer = new S3PresignMediaUrlSigner(options);
    expect(() => signer.sign('../secret', new Date(now.getTime() + 1000))).toThrow(RangeError);
  });
});

describe('web-minted local tokens', () => {
  it('are accepted by the API verifier; refresh tokens are not', async () => {
    const provider = createLocalAuthProvider({
      secret: SECRET,
      publicBaseUrl: 'http://localhost:3010',
    });
    const pkce = await createPkcePair();
    const code = issueLocalCode(SECRET, { email: 'b@shotx.test', name: 'บี' }, pkce.challenge);
    const tokens = await provider.exchangeCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: '',
    });
    const verifier = new LocalTokenVerifier(SECRET);
    await expect(verifier.verify(tokens.accessToken)).resolves.toMatchObject({
      pool: 'users',
      tokenUse: 'access',
      email: 'b@shotx.test',
      name: 'บี',
    });
    await expect(verifier.verify(tokens.idToken ?? '')).resolves.toMatchObject({ tokenUse: 'id' });
    await expect(verifier.verify(tokens.refreshToken ?? '')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('adapter wiring', () => {
  const local = {
    APP_STAGE: 'local',
    NODE_ENV: 'development',
    AUTH_PROVIDER: 'local',
    LOCAL_AUTH_SECRET: SECRET,
    MEDIA_URL_SIGNER: 's3-presign',
    AWS_ENDPOINT_URL: 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  };

  it('uses Cognito and CloudFront by default', () => {
    const config = testConfig();
    expect(config.auth).toEqual({ provider: 'cognito' });
    expect(tokenVerifier(config)).toBeInstanceOf(CognitoTokenVerifier);
    expect(mediaUrlSigner(config)).toBeInstanceOf(CloudFrontMediaUrlSigner);
  });

  it('needs no Cognito or CloudFront variables in local mode', () => {
    const config = testConfig({
      ...local,
      COGNITO_USER_POOL_ID: '',
      COGNITO_WEB_CLIENT_ID: '',
      COGNITO_DOMAIN: '',
      COGNITO_ADMIN_USER_POOL_ID: '',
      COGNITO_ADMIN_CLIENT_ID: '',
      COGNITO_ADMIN_DOMAIN: '',
      CLOUDFRONT_MEDIA_BASE_URL: '',
      CLOUDFRONT_KEY_PAIR_ID: '',
      CLOUDFRONT_PRIVATE_KEY: '',
    });
    expect(config.cognito).toBeNull();
    expect(config.cloudFront).toBeNull();
    expect(tokenVerifier(config)).toBeInstanceOf(LocalTokenVerifier);
    expect(mediaUrlSigner(config)).toBeInstanceOf(S3PresignMediaUrlSigner);
  });

  it('refuses s3-presign without AWS_ENDPOINT_URL, and local options on other stages', () => {
    expect(() => mediaUrlSigner(testConfig({ ...local, AWS_ENDPOINT_URL: '' }))).toThrow(
      /needs AWS_ENDPOINT_URL/,
    );
    expect(() => testConfig({ ...local, APP_STAGE: 'staging' })).toThrow(/needs APP_STAGE=local/);
  });
});
