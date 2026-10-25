import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { plans, storageUsage, subscriptions, users } from '@shotx/db';
import type { Env, SubscriptionStatus } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { createApiApp } from '../app';
import type { ApiConfig, ApiLimits } from '../config';
import type { Db } from '../db/db';
import { CloudFrontMediaUrlSigner } from '../infra/cloudfront-signer';
import { MemoryRateLimiter } from '../infra/redis';
import type { RateLimiter } from '../tokens';
import { FakeObjectStorage, TestAuth, TestClock, testConfig } from './fakes';

export interface TestResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
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
  ) {}

  static async start(
    db: Db,
    options: { env?: Env; limits?: Partial<ApiLimits>; rateLimiter?: RateLimiter } = {},
  ): Promise<TestApi> {
    const config = testConfig(options.env, options.limits);
    const auth = await TestAuth.create(config);
    const storage = new FakeObjectStorage();
    const clock = new TestClock();
    const app = await createApiApp({
      config,
      db,
      storage,
      signer: new CloudFrontMediaUrlSigner(config.cloudFront),
      rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(),
      tokenVerifier: auth.verifier,
      clock,
    });
    await app.listen(0, '127.0.0.1');
    const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    return new TestApi(app, baseUrl, db, config, auth, storage, clock);
  }

  close(): Promise<void> {
    return this.app.close();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: {
      token?: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.rawBody !== undefined) {
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

  /** A users-pool photographer with a live subscription; returns its id and a token. */
  async photographer(
    options: {
      quotaBytes?: number;
      status?: SubscriptionStatus;
      role?: 'photographer' | 'user';
    } = {},
  ): Promise<{ id: string; sub: string; token: string }> {
    const sub = randomUUID();
    const [user] = await this.db
      .insert(users)
      .values({ cognitoPool: 'users', cognitoSub: sub, role: options.role ?? 'photographer' })
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

  async usage(photographerId: string) {
    const [row] = await this.db
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.photographerId, photographerId));
    return row ?? { photographerId, usedBytes: 0, reservedBytes: 0 };
  }
}
