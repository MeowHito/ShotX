import { randomUUID } from 'node:crypto';
import type { INestApplication, LoggerService } from '@nestjs/common';
import {
  type DriveFile,
  files,
  folderPath,
  folders,
  plans,
  seedPlans,
  shares,
  storageUsage,
  subscriptions,
  users,
} from '@shotx/db';
import type { FaceProvider } from '@shotx/face';
import { FakeFaceProvider } from '@shotx/face/testing';
import type { Env, FakeWebhookBody, SubscriptionStatus } from '@shotx/shared';
import {
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  fakeWebhookSignatureHeader,
  generateShareToken,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { createApiApp } from '../app';
import { FakeEmailProvider } from '../billing/email';
import { FakePaymentGateway } from '../billing/gateways';
import { hashPassword } from '../auth/password';
import type { ApiConfig, ApiLimits } from '../config';
import type { Db } from '../db/db';
import { newId } from '../drive/folders';
import { CloudFrontMediaUrlSigner } from '../infra/cloudfront-signer';
import { MemoryEventLog } from '../infra/events';
import { MemoryKeyValueStore, MemoryRateLimiter } from '../infra/redis';
import { MemoryQueueSender } from '../infra/sqs-queue';
import type { RateLimiter, TokenVerifier } from '../tokens';
import type { OidcDeps } from '../auth/oidc';
import type { CaptchaVerifier } from '../public/captcha';
import { tokenVerifier } from '../wiring';
import { testWorld } from './faces';
import {
  FakeObjectStorage,
  requireCloudFront,
  TEST_FAKE_WEBHOOK_SECRET,
  TestAuth,
  TestClock,
  testConfig,
} from './fakes';
import { insertReadyFile } from './seed';

export interface TestResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  rawBody?: string;
  form?: FormData;
  headers?: Record<string, string>;
}

/** Captures everything the app logs. */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
    );
  }
  log(...args: unknown[]) {
    this.push('log', args);
  }
  error(...args: unknown[]) {
    this.push('error', args);
  }
  warn(...args: unknown[]) {
    this.push('warn', args);
  }
  debug(...args: unknown[]) {
    this.push('debug', args);
  }
  verbose(...args: unknown[]) {
    this.push('verbose', args);
  }
  text(): string {
    return this.lines.join('\n');
  }
}

/** A running API on a random port over a test database, with fakes for AWS and Redis. */
export class TestApi {
  private constructor(
    readonly app: INestApplication,
    readonly baseUrl: string,
    readonly db: Db,
    readonly config: ApiConfig,
    readonly auth: TestAuth,
    readonly storage: FakeObjectStorage,
    readonly clock: TestClock,
    readonly store: MemoryKeyValueStore,
    readonly queue: MemoryQueueSender,
    readonly faceProvider: FaceProvider,
    readonly logger: CapturingLogger,
    readonly gateway: FakePaymentGateway,
    readonly email: FakeEmailProvider,
    readonly events: MemoryEventLog,
  ) {}

  static async start(
    db: Db,
    options: {
      env?: Env;
      limits?: Partial<ApiLimits>;
      rateLimiter?: RateLimiter;
      faceProvider?: FaceProvider;
      /** Fake LINE/Google endpoints (FakeOidcProviders.deps) for AUTH_PROVIDER=shotx or local. */
      oidc?: (clock: TestClock) => Partial<OidcDeps>;
      /** CAPTCHA_PROVIDER=turnstile: the verifier (FakeCaptchaVerifier; never the network). */
      captchaVerifier?: CaptchaVerifier;
      /**
       * Let the app build the EMAIL_PROVIDER of its config (createEmailProvider; e.g. `off`)
       * instead of injecting the FakeEmailProvider. Never `ses` (no client in tests).
       */
      configuredEmail?: boolean;
    } = {},
  ): Promise<TestApi> {
    const config = testConfig(options.env, options.limits);
    // With AUTH_PROVIDER=shotx or local the API verifies its own tokens; `auth` then still signs
    // Cognito-like tokens (for helpers' signatures), which that API rejects.
    const cognito = config.auth.provider === 'cognito';
    const auth = await TestAuth.create(cognito ? config : testConfig());
    const storage = new FakeObjectStorage();
    const clock = new TestClock();
    const verifier: TokenVerifier = cognito ? auth.verifier : tokenVerifier(config, clock);
    const store = new MemoryKeyValueStore(() => clock.now().getTime());
    const queue = new MemoryQueueSender();
    const faceProvider = options.faceProvider ?? new FakeFaceProvider(testWorld());
    const logger = new CapturingLogger();
    const gateway = new FakePaymentGateway(
      TEST_FAKE_WEBHOOK_SECRET,
      config.paymentGateway?.webhookToleranceSeconds ?? 300,
      clock,
    );
    const email = new FakeEmailProvider();
    const events = new MemoryEventLog(() => clock.now());
    await seedPlans(db);
    const app = await createApiApp(
      {
        config,
        db,
        storage,
        signer: new CloudFrontMediaUrlSigner(requireCloudFront(config)),
        rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(() => clock.now().getTime()),
        tokenVerifier: verifier,
        clock,
        store,
        queue,
        faceProvider,
        paymentGateway: gateway,
        ...(options.configuredEmail === true ? {} : { email }),
        events,
        oidc: options.oidc?.(clock) ?? {},
        ...(options.captchaVerifier === undefined
          ? {}
          : { captchaVerifier: options.captchaVerifier }),
      },
      logger,
    );
    await app.listen(0, '127.0.0.1');
    const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    return new TestApi(
      app,
      baseUrl,
      db,
      config,
      auth,
      storage,
      clock,
      store,
      queue,
      faceProvider,
      logger,
      gateway,
      email,
      events,
    );
  }

  close(): Promise<void> {
    return this.app.close();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let body: string | FormData | undefined;
    if (options.form !== undefined) {
      body = options.form;
    } else if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers['content-type'] ??= 'application/json';
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    return {
      status: res.status,
      body: (text === '' ? undefined : JSON.parse(text)) as T,
      headers: res.headers,
    };
  }

  /** A browser with a cookie jar, for the public routes. */
  browser(): Browser {
    return new Browser(this);
  }

  /** A users-pool photographer with a live subscription; returns its id and a token. */
  async photographer(
    options: {
      quotaBytes?: number;
      status?: SubscriptionStatus;
      role?: 'photographer' | 'user';
      name?: string;
    } = {},
  ): Promise<{ id: string; sub: string; token: string }> {
    const sub = randomUUID();
    const [user] = await this.db
      .insert(users)
      .values({
        authPool: 'users',
        authSubject: sub,
        role: options.role ?? 'photographer',
        name: options.name ?? null,
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error('no user');
    const code = `p${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const [plan] = await this.db
      .insert(plans)
      .values({
        code,
        name: code,
        quotaBytes: options.quotaBytes ?? 1024 * 1024 * 1024,
        priceMonthSatang: 0,
        priceYearSatang: 0,
        // A private test plan: never listed by GET /plans or purchasable.
        isActive: false,
      })
      .returning({ id: plans.id });
    if (plan === undefined) throw new Error('no plan');
    await this.db.insert(subscriptions).values({
      photographerId: user.id,
      planId: plan.id,
      status: options.status ?? 'active',
      periodEnd: new Date('2027-01-01T00:00:00Z'),
    });
    return { id: user.id, sub, token: await this.auth.token('users', sub) };
  }

  /**
   * A photographer on a seed plan (`starter`, `standard`, `pro`, `studio`, `trial`), with the
   * subscription shaped by `options`. Returns the ids and a token.
   */
  async photographerOn(
    planCode: string,
    options: {
      status?: SubscriptionStatus;
      periodStart?: Date;
      periodEnd?: Date;
      card?: { ref: string; months: 1 | 12 } | null;
      email?: string | null;
      noSubscription?: boolean;
    } = {},
  ): Promise<{ id: string; sub: string; token: string; subscriptionId: string | null }> {
    const sub = randomUUID();
    const [user] = await this.db
      .insert(users)
      .values({
        authPool: 'users',
        authSubject: sub,
        role: 'photographer',
        email: options.email === undefined ? `p-${sub.slice(0, 8)}@example.com` : options.email,
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error('no user');
    let subscriptionId: string | null = null;
    if (options.noSubscription !== true) {
      const [plan] = await this.db.select().from(plans).where(eq(plans.code, planCode));
      if (plan === undefined) throw new Error(`no plan ${planCode}`);
      const now = this.clock.now();
      const card = options.card ?? null;
      const [row] = await this.db
        .insert(subscriptions)
        .values({
          photographerId: user.id,
          planId: plan.id,
          status: options.status ?? 'active',
          periodStart: options.periodStart ?? now,
          periodEnd: options.periodEnd ?? new Date(now.getTime() + 30 * 86_400_000),
          billing: card === null ? 'prepaid' : 'auto_renew',
          autoRenewMonths: card?.months ?? null,
          paymentMethodGateway: card === null ? null : 'fake',
          paymentMethodRef: card?.ref ?? null,
        })
        .returning({ id: subscriptions.id });
      subscriptionId = row?.id ?? null;
    }
    return { id: user.id, sub, token: await this.auth.token('users', sub), subscriptionId };
  }

  /** POSTs a fake-gateway webhook, signed with the test secret at the test clock (or `signedAt`). */
  async webhook(
    body: FakeWebhookBody,
    options: { secret?: string; signedAt?: Date; header?: string; raw?: string } = {},
  ): Promise<TestResponse> {
    const raw = options.raw ?? JSON.stringify(body);
    const at = Math.floor((options.signedAt ?? this.clock.now()).getTime() / 1000);
    const header =
      options.header ??
      (await fakeWebhookSignatureHeader(
        options.secret ?? TEST_FAKE_WEBHOOK_SECRET,
        at,
        new TextEncoder().encode(raw),
      ));
    return this.request('POST', '/api/billing/webhooks/fake', {
      rawBody: raw,
      headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: header },
    });
  }

  /** A users-pool viewer (role user); the row is created like the guard would. */
  async viewer(): Promise<{ id: string; sub: string; token: string }> {
    const sub = randomUUID();
    const [user] = await this.db
      .insert(users)
      .values({ authPool: 'users', authSubject: sub, role: 'user' })
      .returning({ id: users.id });
    if (user === undefined) throw new Error('no user');
    return { id: user.id, sub, token: await this.auth.token('users', sub) };
  }

  async usage(photographerId: string) {
    const [row] = await this.db
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.photographerId, photographerId));
    return row ?? { photographerId, usedBytes: 0, reservedBytes: 0 };
  }

  /** A live folder of `ownerId` (direct insert), optionally with an active face index. */
  async folder(
    ownerId: string,
    options: {
      name?: string;
      parent?: { id: string; path: string } | null;
      faceIndex?: boolean;
    } = {},
  ): Promise<{ id: string; path: string }> {
    const id = await newId(this.db);
    const now = this.clock.now();
    const [row] = await this.db
      .insert(folders)
      .values({
        id,
        ownerId,
        parentId: options.parent?.id ?? null,
        name: options.name ?? `folder-${id.slice(-6)}`,
        path: folderPath(options.parent?.path ?? null, id),
        ...(options.faceIndex === true
          ? {
              faceIndexEnabled: true,
              faceIndexInformedAt: now,
              faceIndexExpiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
            }
          : {}),
      })
      .returning({ id: folders.id, path: folders.path });
    if (row === undefined) throw new Error('no folder');
    return row;
  }

  /** A ready image in `folderId`. */
  file(
    ownerId: string,
    folderId: string | null,
    name = `IMG_${randomUUID().slice(0, 8)}.jpg`,
  ): Promise<DriveFile> {
    return insertReadyFile(this.db, ownerId, { name, folderId, webSizeBytes: 500 });
  }

  /** A share row (direct insert, for public-route tests). */
  async share(
    ownerId: string,
    target: { fileId: string } | { folderId: string },
    options: Partial<{
      mode: 'gallery' | 'face_only';
      allowDownload: boolean;
      downloadSize: 'web' | 'original';
      requireLogin: boolean;
      password: string;
      expiresAt: Date;
      isActive: boolean;
    }> = {},
  ): Promise<{ id: string; token: string }> {
    const token = generateShareToken();
    const [row] = await this.db
      .insert(shares)
      .values({
        ownerId,
        ...('fileId' in target
          ? { targetType: 'file' as const, targetFileId: target.fileId }
          : { targetType: 'folder' as const, targetFolderId: target.folderId }),
        token,
        mode: options.mode ?? 'gallery',
        allowDownload: options.allowDownload ?? true,
        downloadSize: options.downloadSize ?? 'web',
        requireLogin: options.requireLogin ?? false,
        passwordHash: options.password === undefined ? null : await hashPassword(options.password),
        expiresAt: options.expiresAt ?? null,
        isActive: options.isActive ?? true,
      })
      .returning({ id: shares.id, token: shares.token });
    if (row === undefined) throw new Error('no share');
    return row;
  }

  /** Marks files as trashed (for scope tests). */
  async trashFile(fileId: string): Promise<void> {
    await this.db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, fileId));
  }
}

/**
 * A browser for the public routes: keeps the cookies the API sets (by name and path) and sends the
 * ones whose path matches, like a real browser.
 */
export class Browser {
  private readonly cookies = new Map<string, { path: string; value: string }>();
  /** Bearer token to send (server-side callers), if any. */
  token: string | undefined;
  /** Headers sent with every request (e.g. CloudFront-Viewer-Address). */
  headers: Record<string, string> = {};

  constructor(private readonly api: TestApi) {}

  cookie(name: string, path?: string): string | undefined {
    for (const [key, c] of this.cookies) {
      if (key.startsWith(`${name}|`) && (path === undefined || c.path === path)) return c.value;
    }
    return undefined;
  }

  /** The Cookie header this browser would send to `path`. */
  cookieHeader(path: string): string {
    return [...this.cookies.entries()]
      .filter(
        ([, c]) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`),
      )
      .map(([key, c]) => `${key.split('|')[0]}=${c.value}`)
      .join('; ');
  }

  setCookie(name: string, value: string, path = '/'): void {
    this.cookies.set(`${name}|${path}`, { path, value });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse<T>> {
    const pathname = path.split('?')[0] ?? path;
    const sent = [...this.cookies.entries()]
      .filter(
        ([, c]) =>
          pathname === c.path || pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`),
      )
      .sort((a, b) => b[1].path.length - a[1].path.length)
      .map(([key, c]) => `${key.split('|')[0]}=${c.value}`);
    const headers: Record<string, string> = { ...this.headers, ...options.headers };
    if (sent.length > 0) headers.cookie = sent.join('; ');
    const res = await this.api.request<T>(method, path, {
      ...options,
      headers,
      ...(this.token === undefined || options.token !== undefined ? {} : { token: this.token }),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const [name, value] = (pair ?? '').split('=');
      const cookiePath = attrs.find((a) => a.startsWith('Path='))?.slice(5) ?? '/';
      const maxAge = attrs.find((a) => a.startsWith('Max-Age='))?.slice(8);
      if (name === undefined) continue;
      if (maxAge === '0') this.cookies.delete(`${name}|${cookiePath}`);
      else this.cookies.set(`${name}|${cookiePath}`, { path: cookiePath, value: value ?? '' });
    }
    return res;
  }
}
