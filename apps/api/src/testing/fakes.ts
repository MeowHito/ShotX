import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AuthPool, Env } from '@shotx/shared';
import {
  createLocalJWKSet,
  exportJWK,
  type JWK,
  type JWTPayload,
  type KeyObject as JoseKey,
  SignJWT,
} from 'jose';
import { CognitoTokenVerifier } from '../auth/cognito-verifier';
import { type ApiConfig, type ApiLimits, loadApiConfig } from '../config';
import type { Clock, ObjectStorage, UploadedPart } from '../tokens';

/** A test RSA private key in PKCS#8 PEM (CloudFront signing). */
export function testPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export const TEST_POOL_IDS: Record<AuthPool, string> = {
  users: 'ap-southeast-1_UsersPool1',
  admins: 'ap-southeast-1_AdminsPool1',
};
export const TEST_CLIENT_IDS: Record<AuthPool, string> = {
  users: 'webclient123',
  admins: 'adminclient456',
};

/** A complete API environment with test values, parsed by the real shared loaders. */
export function testEnv(overrides: Env = {}): Env {
  return {
    NODE_ENV: 'test',
    APP_STAGE: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ADMIN_BASE_URL: 'http://localhost:3001',
    MEDIA_BUCKET: 'shotx-test-media',
    REDIS_URL: 'redis://localhost:6379',
    CLOUDFRONT_MEDIA_BASE_URL: 'https://photos.example.com/media',
    CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
    CLOUDFRONT_PRIVATE_KEY: testPrivateKeyPem(),
    COGNITO_USER_POOL_ID: TEST_POOL_IDS.users,
    COGNITO_WEB_CLIENT_ID: TEST_CLIENT_IDS.users,
    COGNITO_DOMAIN: 'https://users.auth.ap-southeast-1.amazoncognito.com',
    COGNITO_ADMIN_USER_POOL_ID: TEST_POOL_IDS.admins,
    COGNITO_ADMIN_CLIENT_ID: TEST_CLIENT_IDS.admins,
    COGNITO_ADMIN_DOMAIN: 'https://admins.auth.ap-southeast-1.amazoncognito.com',
    // 5 MiB parts (the S3 minimum) keep test sizes small.
    UPLOAD_PART_BYTES: String(5 * 1024 * 1024),
    UPLOAD_INIT_PRESIGNED_PARTS: '2',
    DRIVE_PAGE_SIZE: '3',
    DRIVE_MAX_FOLDER_DEPTH: '4',
    IP_HASH_SECRET: 'test-ip-hash-secret-0123456789abcdef',
    FACE_SEARCH_MAX_SELFIE_BYTES: String(1024 * 1024),
    FACE_SEARCH_MAX_BODY_BYTES: String(3 * 1024 * 1024 + 64 * 1024),
    FACES_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/shotx-test-faces',
    ZIP_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/shotx-test-zip',
    ...overrides,
  };
}

export function testConfig(overrides: Env = {}, limits: Partial<ApiLimits> = {}): ApiConfig {
  const config = loadApiConfig(testEnv(overrides));
  return { ...config, limits: { ...config.limits, ...limits } };
}

export class TestClock implements Clock {
  constructor(private current = new Date('2026-10-25T05:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Signs Cognito-like JWTs for both pools with local keys, and verifies them the real way. */
export class TestAuth {
  private readonly keys: Record<AuthPool, { privateKey: JoseKey; jwk: JWK }>;
  readonly verifier: CognitoTokenVerifier;

  private constructor(
    keys: Record<AuthPool, { privateKey: JoseKey; jwk: JWK }>,
    private readonly config: ApiConfig,
  ) {
    this.keys = keys;
    const jwks = (pool: AuthPool) => createLocalJWKSet({ keys: [keys[pool].jwk] });
    this.verifier = new CognitoTokenVerifier(config.cognito, {
      users: jwks('users'),
      admins: jwks('admins'),
    });
  }

  static async create(config: ApiConfig): Promise<TestAuth> {
    const make = async (kid: string) => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
      return { privateKey: privateKey as unknown as JoseKey, jwk };
    };
    return new TestAuth(
      { users: await make('users-key'), admins: await make('admins-key') },
      config,
    );
  }

  /** A token of `pool` for `sub`. Options forge bad tokens for negative tests. */
  async token(
    pool: AuthPool,
    sub: string,
    options: {
      tokenUse?: 'id' | 'access';
      signWith?: AuthPool;
      issuer?: string;
      clientId?: string;
      expiresIn?: string;
      extra?: JWTPayload;
    } = {},
  ): Promise<string> {
    const tokenUse = options.tokenUse ?? 'access';
    const clientId = options.clientId ?? this.config.cognito[pool].clientId;
    const signer = this.keys[options.signWith ?? pool];
    const jwt = new SignJWT({
      token_use: tokenUse,
      ...(tokenUse === 'access' ? { client_id: clientId } : {}),
      ...options.extra,
    })
      .setProtectedHeader({ alg: 'RS256', kid: signer.jwk.kid ?? '' })
      .setSubject(sub)
      .setIssuer(options.issuer ?? this.config.cognito[pool].issuer)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '1h');
    if (tokenUse === 'id') jwt.setAudience(clientId);
    return jwt.sign(signer.privateKey);
  }
}

interface FakeUpload {
  key: string;
  contentType: string;
  parts: Map<number, { etag: string; size: number }>;
}

/** In-memory multipart uploads with S3's semantics for the calls the API makes. */
export class FakeObjectStorage implements ObjectStorage {
  readonly uploads = new Map<string, FakeUpload>();
  readonly objects = new Map<string, { size: number; contentType: string }>();
  readonly calls: string[] = [];
  /** Make the next CompleteMultipartUpload succeed in S3 but throw (a lost response). */
  failAfterNextComplete = false;

  createMultipartUpload(input: { key: string; contentType: string }): Promise<string> {
    this.calls.push(`create ${input.key}`);
    const uploadId = `upload-${randomUUID()}`;
    this.uploads.set(uploadId, {
      key: input.key,
      contentType: input.contentType,
      parts: new Map(),
    });
    return Promise.resolve(uploadId);
  }

  presignUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<string> {
    const q = new URLSearchParams({
      uploadId: input.uploadId,
      partNumber: String(input.partNumber),
      'X-Amz-Expires': String(input.expiresInSeconds),
    });
    return Promise.resolve(
      `https://shotx-test-media.s3.ap-southeast-1.amazonaws.com/${input.key}?${q.toString()}`,
    );
  }

  /** What a browser PUT to a part URL does. Returns the ETag (quoted, as S3 sends it). */
  putPart(uploadId: string, partNumber: number, size: number): string {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw new Error('NoSuchUpload');
    const etag = `"etag-${partNumber}-${size}"`;
    upload.parts.set(partNumber, { etag, size });
    return etag;
  }

  listParts(input: { key: string; uploadId: string }): Promise<UploadedPart[] | null> {
    this.calls.push(`list ${input.key}`);
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined || upload.key !== input.key) return Promise.resolve(null);
    return Promise.resolve(
      [...upload.parts.entries()]
        .map(([partNumber, p]) => ({ partNumber, etag: p.etag, size: p.size }))
        .sort((a, b) => a.partNumber - b.partNumber),
    );
  }

  completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<boolean> {
    this.calls.push(`complete ${input.key}`);
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined || upload.key !== input.key) return Promise.resolve(false);
    const size = [...upload.parts.values()].reduce((sum, p) => sum + p.size, 0);
    this.uploads.delete(input.uploadId);
    this.objects.set(input.key, { size, contentType: upload.contentType });
    if (this.failAfterNextComplete) {
      this.failAfterNextComplete = false;
      return Promise.reject(new Error('socket hang up'));
    }
    return Promise.resolve(true);
  }

  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void> {
    this.calls.push(`abort ${input.key}`);
    this.uploads.delete(input.uploadId);
    return Promise.resolve();
  }

  headObject(key: string): Promise<{ size: number } | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : { size: object.size });
  }
}
