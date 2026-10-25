import { createPublicKey, createVerify } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { ArgumentsHost } from '@nestjs/common';
import { users } from '@shotx/db';
import { derivedKey } from '@shotx/shared';
import { mockClient } from 'aws-sdk-client-mock';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './auth/password';
import { profileClaims } from './auth/cognito-verifier';
import { DriveFileMapper } from './drive/media-urls';
import { clientIp, ipHash } from './http/client';
import { describeError, scrubMessage } from './http/exception.filter';
import { ApiExceptionFilter } from './http/exception.filter';
import { selfieMagicMatches } from './http/multipart';
import { CloudFrontMediaUrlSigner } from './infra/cloudfront-signer';
import { MemoryKeyValueStore, RedisKeyValueStore } from './infra/redis';
import { MemoryQueueSender, SqsQueueSender } from './infra/sqs-queue';
import { SignedUrls } from './media/signed-urls';
import { openPglite } from './testing/database';
import { CapturingLogger } from './testing/harness';
import { TestClock, testConfig } from './testing/fakes';

describe('error logging (no PII)', () => {
  it('logs a Drizzle error with PII parameters as class, pg code and a scrubbed message', async () => {
    const database = await openPglite();
    let thrown: unknown;
    try {
      // users_cognito_sub_not_empty fails; the parameters carry an email and a name.
      await database.db.insert(users).values({
        cognitoPool: 'users',
        cognitoSub: '',
        email: 'somchai.secret@example.com',
        name: 'ไฟล์ลับ IMG_0001.jpg',
      });
    } catch (error) {
      thrown = error;
    } finally {
      await database.close();
    }
    expect(thrown).toBeInstanceOf(Error);
    // The raw error does carry them (that is the risk).
    expect(String((thrown as Error).message)).toContain('somchai.secret@example.com');

    const logger = new CapturingLogger();
    const filter = new ApiExceptionFilter(logger);
    const res = {
      headersSent: false,
      setHeader: () => undefined,
      status: () => ({ json: () => undefined }),
    };
    const req = { method: 'POST', route: { path: '/api/drive/folders' } } as unknown as Request;
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as unknown as ArgumentsHost;
    filter.catch(thrown, host);

    const text = logger.text();
    expect(text).toContain('POST /api/drive/folders failed:');
    expect(text).toContain('pg=23514');
    expect(text).toContain('constraint=users_cognito_sub_not_empty');
    for (const pii of [
      'somchai.secret',
      'example.com',
      'IMG_0001',
      'ไฟล์ลับ',
      'params',
      'insert into',
    ]) {
      expect(text.toLowerCase()).not.toContain(pii.toLowerCase());
    }
    expect(text).not.toMatch(/\n\s+at /);
  });

  it('scrubs quoted values, emails, numbers and tokens from messages', () => {
    expect(scrubMessage('invalid input syntax for type uuid: "originals/u/f/ลับ.jpg"')).toBe(
      'invalid input syntax for type uuid: ?',
    );
    expect(scrubMessage('Key (email)=(a@b.co) already exists')).toBe('Key (?)=(?) already exists');
    expect(scrubMessage('contact a@b.co about 12345')).toBe('contact ? about ?');
    expect(scrubMessage('token eyJhbGciOiJSUzI1NiJ9abcdefghijkl leaked')).toBe('token ? leaked');
    expect(scrubMessage('Failed query: insert into "users" ...\nparams: x@y.z')).toBe(
      'query failed',
    );
    expect(scrubMessage('first line\nsecond line with secret')).toBe('first line');
    expect(describeError('a string')).toBe('non-error thrown');
    expect(describeError(new TypeError('bad "secret"'))).toBe('TypeError bad ?');
  });
});

describe('signed URLs', () => {
  const config = testConfig();
  const signer = new CloudFrontMediaUrlSigner(config.cloudFront);
  const key = derivedKey(
    {
      photographerId: '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b',
      fileId: '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c',
    },
    'web',
  );

  it('signs response-content-disposition into the URL (canned policy covers the query)', () => {
    const expiresAt = new Date('2026-10-25T06:00:00Z');
    const url = new URL(
      signer.sign(key, expiresAt, { contentDisposition: 'attachment; filename="a.jpg"' }),
    );
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="a.jpg"',
    );
    const resource = `https://photos.example.com/media/${key}?response-content-disposition=${encodeURIComponent('attachment; filename="a.jpg"')}`;
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: resource,
          Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt.getTime() / 1000 } },
        },
      ],
    });
    const signature = (url.searchParams.get('Signature') ?? '')
      .replace(/-/g, '+')
      .replace(/_/g, '=')
      .replace(/~/g, '/');
    expect(
      createVerify('RSA-SHA1')
        .update(policy)
        .verify(createPublicKey(config.cloudFront.privateKey), signature, 'base64'),
    ).toBe(true);
  });

  it('issues byte-identical URLs within one bucket window, new ones after it', () => {
    const clock = new TestClock(new Date('2026-10-25T05:00:01.000Z'));
    const urls = new SignedUrls(signer, config, clock);
    const mapper = new DriveFileMapper(urls);
    const row = { thumbKey: key, previewKey: key, posterKey: null, purgeRequestedAt: null };
    const file = () =>
      mapper.toDriveFile({
        ...row,
        id: '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c',
        folderId: null,
        name: 'a.jpg',
        mime: 'image/jpeg',
        sizeBytes: 1,
        status: 'ready',
        width: null,
        height: null,
        takenAt: null,
        faceCount: null,
        createdAt: new Date(),
        deletedAt: null,
      } as never);
    const first = file().thumbUrl;
    clock.advance(4 * 60_000);
    expect(file().thumbUrl).toBe(first);
    clock.advance(2 * 60_000);
    expect(file().thumbUrl).not.toBe(first);
    const download = urls.download(key, 'ภาพ.jpg');
    expect(download.expiresAt.getTime() % (config.share.signedUrlExpiryBucketSeconds * 1000)).toBe(
      0,
    );
  });
});

describe('passwords', () => {
  it('hashes with argon2id in PHC format, salted, and verifies in constant time', async () => {
    const a = await hashPassword('1234');
    const b = await hashPassword('1234');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('1234', a)).toBe(true);
    expect(await verifyPassword('12345', a)).toBe(false);
    expect(await verifyPassword('1234', 'plain')).toBe(false);
    // A corrupt row can't make the API burn memory.
    expect(await verifyPassword('1234', a.replace('m=19456', 'm=9999999'))).toBe(false);
  });
});

describe('client address and ip_hash', () => {
  const req = (headers: Record<string, string>, remote = '10.0.0.9') =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as Request;

  it('reads CloudFront-Viewer-Address, else the socket', () => {
    expect(clientIp(req({ 'cloudfront-viewer-address': '203.0.113.10:51234' }))).toBe(
      '203.0.113.10',
    );
    expect(clientIp(req({ 'cloudfront-viewer-address': '2001:db8::1:443' }))).toBe('2001:db8::1');
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.9');
  });

  it('is a keyed v1 hash of the normalized address', () => {
    const secret = 'x'.repeat(32);
    expect(ipHash(secret, '203.0.113.10')).toMatch(/^v1:[A-Za-z0-9_-]{43}$/);
    expect(ipHash(secret, '::ffff:203.0.113.10')).toBe(ipHash(secret, '203.0.113.10'));
    expect(ipHash('y'.repeat(32), '203.0.113.10')).not.toBe(ipHash(secret, '203.0.113.10'));
    expect(ipHash(secret, '203.0.113.10')).not.toContain('203');
  });
});

describe('profile claims', () => {
  it('takes a verified email and a name from ID tokens only', () => {
    expect(profileClaims('id', { email: 'a@b.co', email_verified: true, name: ' A ' })).toEqual({
      email: 'a@b.co',
      name: 'A',
    });
    expect(profileClaims('id', { email: 'a@b.co', email_verified: false })).toEqual({
      email: null,
      name: null,
    });
    expect(profileClaims('access', { email: 'a@b.co', email_verified: true })).toEqual({
      email: null,
      name: null,
    });
  });
});

describe('selfie magic bytes', () => {
  it('matches JPEG and PNG signatures only', () => {
    expect(selfieMagicMatches('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(
      selfieMagicMatches(
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(true);
    expect(selfieMagicMatches('image/png', Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(selfieMagicMatches('image/gif', Buffer.from('GIF89a'))).toBe(false);
  });
});

describe('key-value stores', () => {
  it('MemoryKeyValueStore expires keys and takes hash fields atomically', async () => {
    let now = 0;
    const store = new MemoryKeyValueStore(() => now);
    await store.setWithTtl('k', 'v', 10);
    await store.hashSetWithTtl('h', { a: '1', b: '2' }, 10);
    expect(await store.hashTake('h', 'a')).toBe('1');
    expect(await store.hashTake('h', 'a')).toBeNull();
    now = 10_000;
    expect(await store.get('k')).toBeNull();
    expect(await store.hashGetAll('h')).toEqual({});
    store.failing = true;
    await expect(store.get('k')).rejects.toThrow();
  });

  it('RedisKeyValueStore prefixes keys, sets TTLs in one MULTI and propagates errors', async () => {
    const calls: unknown[][] = [];
    const multi = {
      hset: (...a: unknown[]) => (calls.push(['hset', ...a]), multi),
      expire: (...a: unknown[]) => (calls.push(['expire', ...a]), multi),
      exec: () =>
        Promise.resolve([
          [null, 1],
          [null, 1],
        ]),
    };
    const client = {
      get: (k: string) => (calls.push(['get', k]), Promise.resolve('v')),
      set: (...a: unknown[]) => (calls.push(['set', ...a]), Promise.resolve('OK')),
      del: (...a: unknown[]) => (calls.push(['del', ...a]), Promise.resolve(1)),
      hgetall: () => Promise.reject(new Error('down')),
      multi: () => multi,
      eval: (...a: unknown[]) => (calls.push(['eval', ...a.slice(1)]), Promise.resolve('96.0')),
    };
    const store = new RedisKeyValueStore(client as never, 'shotx:test:api:');
    await store.setWithTtl('share-unlock:x', 'f', 60);
    await store.hashSetWithTtl('face-scan:s:a', { f: '96.0' }, 86400);
    expect(await store.hashTake('face-scan:s:a', 'f')).toBe('96.0');
    await store.del('a', 'b');
    expect(calls).toEqual([
      ['set', 'shotx:test:api:share-unlock:x', 'f', 'EX', 60],
      ['hset', 'shotx:test:api:face-scan:s:a', { f: '96.0' }],
      ['expire', 'shotx:test:api:face-scan:s:a', 86400],
      ['eval', 1, 'shotx:test:api:face-scan:s:a', 'f'],
      ['del', 'shotx:test:api:a', 'shotx:test:api:b'],
    ]);
    await expect(store.hashGetAll('x')).rejects.toThrow('down');
  });

  const redisUrl = process.env.TEST_REDIS_URL ?? '';
  describe.skipIf(redisUrl === '')('RedisKeyValueStore on a real Redis (TEST_REDIS_URL)', () => {
    const redis = new Redis(redisUrl, { lazyConnect: true });
    afterAll(() => redis.disconnect());

    it('round-trips with TTLs on every key', async () => {
      const prefix = `shotx:test-${Date.now()}:api:`;
      const store = new RedisKeyValueStore(redis, prefix);
      await store.setWithTtl('a', '1', 30);
      await store.hashSetWithTtl('h', { f: '90.0', g: '96.5' }, 60);
      expect(await store.get('a')).toBe('1');
      expect(await store.hashTake('h', 'f')).toBe('90.0');
      expect(await store.hashGetAll('h')).toEqual({ g: '96.5' });
      expect(await redis.ttl(`${prefix}a`)).toBeGreaterThan(0);
      expect(await redis.ttl(`${prefix}h`)).toBeGreaterThan(0);
      await store.del('a', 'h');
    });
  });
});

describe('queue senders', () => {
  const sqs = mockClient(SQSClient);
  afterAll(() => sqs.restore());

  it('sends validated job bodies to the right queue URL', async () => {
    sqs.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    const sender = new SqsQueueSender(new SQSClient({ region: 'ap-southeast-1' }), {
      faces: 'https://sqs.example/faces',
      zip: 'https://sqs.example/zip',
    });
    const jobId = '0195f3a2-af4b-7a7d-8e5c-6f7a8b9cadbe';
    await sender.send('zip', { type: 'zip.create', jobId });
    expect(sqs.commandCalls(SendMessageCommand)[0]?.args[0].input).toEqual({
      QueueUrl: 'https://sqs.example/zip',
      MessageBody: JSON.stringify({ type: 'zip.create', jobId }),
    });
    await expect(
      sender.send('faces', { type: 'delete.faces', deletionId: 'nope' }),
    ).rejects.toThrow('Invalid faces queue message');
    const memory = new MemoryQueueSender();
    await memory.send('faces', { type: 'index.folder', folderId: jobId });
    expect(memory.messages('faces')).toEqual([{ type: 'index.folder', folderId: jobId }]);
  });
});
