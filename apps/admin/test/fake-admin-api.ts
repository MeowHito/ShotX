import {
  type AccountRole,
  ADMIN_ROUTES,
  type AdminCashPayment,
  type AdminSystemResponse,
  type AdminUser,
  createAdminUserBodySchema,
  createCashPaymentBodySchema,
  ERROR_HTTP_STATUS,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  listAdminUsersQuerySchema,
  listCashPaymentsQuerySchema,
  normalizeAccountEmail,
  type PasswordTooWeakDetails,
  resetAdminUserPasswordBodySchema,
  type RouteContract,
  updateAdminUserBodySchema,
} from '@shotx/shared';
import { matchRoute } from '@/lib/bff/handler';
import { urlOf } from './fetch';

/**
 * In-memory stand-in for the API's /admin/* routes as the admin app assumes they behave (the real
 * ones are built in parallel in apps/api), reached through the browser client at `/bff`.
 * Requests are parsed with the contract schemas and answers are checked against them, so a
 * drift from @shotx/shared fails the tests. Every call is recorded (method, path, headers, body).
 *
 * Modelled rules: EMAIL_TAKEN (ASCII case ignored), PASSWORD_TOO_WEAK below `minLength`,
 * CANNOT_MODIFY_SELF (disable or reset own account), LAST_ADMIN, cursor pages of `pageSize`,
 * cash payments idempotent per Idempotency-Key (IDEMPOTENCY_KEY_REUSED for another body).
 */

export const SELF_ID = '00000000-0000-4000-8000-000000000001';

export interface RecordedCall {
  route: RouteContract;
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

let counter = 100;
const nextId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;

export function makeUser(overrides: Partial<AdminUser> = {}): AdminUser {
  const role = overrides.role ?? 'photographer';
  return {
    // Admins: enrolled unless a test says otherwise; photographers have no TOTP (null).
    totpEnrolled: role === 'admin' ? true : null,
    id: nextId(),
    email: 'someone@example.com',
    name: 'Someone',
    role: 'photographer',
    status: 'active',
    passwordAccount: true,
    mustChangePassword: false,
    lockedUntil: null,
    createdAt: '2026-11-01T03:00:00.000Z',
    createdById: SELF_ID,
    disabledAt: null,
    lastSignInAt: null,
    usedBytes: 0,
    photoCount: 0,
    ...overrides,
  };
}

class Fail extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: unknown,
    readonly status?: number,
  ) {
    super(code);
  }
}

export class FakeAdminApi {
  readonly calls: RecordedCall[] = [];
  users: AdminUser[] = [];
  payments: AdminCashPayment[] = [];
  pageSize = 50;
  /** TEMPORARY_PASSWORD_MIN_LENGTH, the only rule for admin-set passwords (ADR 0015). */
  minLength: Record<AccountRole, number> = { admin: 4, photographer: 4 };
  /** Fail the next calls of a route with this error instead (consumed in order). */
  readonly failures = new Map<RouteContract, Fail[]>();
  /** GET /admin/system (ADR 0016). */
  system: AdminSystemResponse = {
    generatedAt: '2026-11-13T05:00:00.000Z',
    storage: {
      originalsBytes: 120 * 1024 ** 3,
      photoCount: 54_321,
      videoCount: 12,
      photographerCount: 7,
      databaseBytes: 2 * 1024 ** 3,
    },
    bucket: {
      name: 'snap-media',
      objectCount: 160_000,
      totalBytes: 150 * 1024 ** 3,
      prefixes: [
        { prefix: 'originals/', objectCount: 54_000, bytes: 120 * 1024 ** 3 },
        { prefix: 'derived/', objectCount: 106_000, bytes: 30 * 1024 ** 3 },
      ],
      measuredAt: '2026-11-13T04:55:00.000Z',
    },
    server: {
      hostname: 'vps',
      cpuCount: 8,
      cpuPercent: 12.5,
      loadAverage: [0.8, 0.6, 0.5],
      memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 24 * 1024 ** 3 },
      disk: { path: '/', totalBytes: 400 * 1024 ** 3, usedBytes: 380 * 1024 ** 3 },
      uptimeSeconds: 2 * 86_400 + 5 * 3600,
      temperatureC: null,
    },
    // 150 GB in R2: (150 − 10) × $0.015 = $2.10; the VPS 1,529 THB.
    cost: { usdThb: 33, r2StorageUsdMonth: 2.1, r2FreeStorageGb: 10, vpsThbMonth: 1529 },
  };
  private readonly idempotency = new Map<string, { body: string; payment: AdminCashPayment }>();

  constructor(users: AdminUser[] = []) {
    this.users = [
      makeUser({
        id: SELF_ID,
        email: 'owner@example.test',
        name: 'Owner',
        role: 'admin',
        createdById: null,
        usedBytes: null,
        photoCount: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      ...users,
    ];
  }

  failNext(route: RouteContract, code: ErrorCode, details?: unknown, status?: number) {
    const list = this.failures.get(route) ?? [];
    list.push(new Fail(code, details, status));
    this.failures.set(route, list);
  }

  callsOf(route: RouteContract): RecordedCall[] {
    return this.calls.filter((c) => c.route === route);
  }

  readonly fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(input, init));

  private respond(input: RequestInfo | URL, init: RequestInit | undefined): Response {
    const url = new URL(urlOf(input), 'http://admin.test');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/bff/, '');
    const route = matchRoute(method, path);
    if (route === null) return this.error(new Fail(ErrorCode.NOT_FOUND));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ route, method, path, search: url.searchParams, headers, body });
    const queued = this.failures.get(route)?.shift();
    if (queued !== undefined) return this.error(queued);
    try {
      const { status, value } = this.handle(route, path, url.searchParams, headers, body);
      const parsed = route.response?.parse(value);
      return new Response(JSON.stringify(parsed), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (error instanceof Fail) return this.error(error);
      throw error;
    }
  }

  private error(fail: Fail): Response {
    return new Response(
      JSON.stringify({
        code: fail.code,
        message: fail.code,
        ...(fail.details !== undefined ? { details: fail.details } : {}),
      }),
      {
        status: fail.status ?? ERROR_HTTP_STATUS[fail.code],
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  private find(id: string): AdminUser {
    const user = this.users.find((u) => u.id === id);
    if (user === undefined) throw new Fail(ErrorCode.NOT_FOUND);
    return user;
  }

  private checkPassword(password: string, role: AccountRole) {
    const minLength = this.minLength[role];
    if ([...password].length < minLength) {
      const details: PasswordTooWeakDetails = { reason: 'too_short', minLength };
      throw new Fail(ErrorCode.PASSWORD_TOO_WEAK, details);
    }
  }

  private page<T>(items: T[], cursor: string | null, cursorOf: (item: T) => string) {
    const start = cursor === null ? 0 : items.findIndex((i) => cursorOf(i) === cursor) + 1;
    const slice = items.slice(start, start + this.pageSize);
    const more = start + this.pageSize < items.length;
    const last = slice.at(-1);
    return { items: slice, nextCursor: more && last !== undefined ? cursorOf(last) : null };
  }

  private handle(
    route: RouteContract,
    path: string,
    search: URLSearchParams,
    headers: Record<string, string>,
    body: unknown,
  ): { status: number; value: unknown } {
    const id = path.split('/')[3] ?? '';
    switch (route) {
      case ADMIN_ROUTES.listUsers: {
        const q = listAdminUsersQuerySchema.parse(Object.fromEntries(search));
        const items = this.users
          .filter((u) => q.role === undefined || u.role === q.role)
          .filter((u) => q.status === undefined || u.status === q.status)
          .filter(
            (u) =>
              q.q === undefined ||
              [u.email, u.name].some((v) => v?.toLowerCase().includes(q.q!.toLowerCase())),
          );
        return { status: 200, value: this.page(items, q.cursor ?? null, (u) => `c-${u.id}`) };
      }
      case ADMIN_ROUTES.getUser:
        return { status: 200, value: this.find(id) };
      case ADMIN_ROUTES.createUser: {
        const b = createAdminUserBodySchema.parse(body);
        if (
          this.users.some(
            (u) => u.email && normalizeAccountEmail(u.email) === normalizeAccountEmail(b.email),
          )
        ) {
          throw new Fail(ErrorCode.EMAIL_TAKEN);
        }
        this.checkPassword(b.password, b.role);
        const user = makeUser({
          email: b.email,
          name: b.name,
          role: b.role,
          mustChangePassword: true,
          // A UI-created admin enrols TOTP at their first sign-in (ADMIN_SIGN_IN_STEPS).
          totpEnrolled: b.role === 'admin' ? false : null,
          usedBytes: b.role === 'photographer' ? 0 : null,
          photoCount: b.role === 'photographer' ? 0 : null,
          createdAt: '2026-11-10T05:00:00.000Z',
        });
        this.users.unshift(user);
        return { status: 201, value: user };
      }
      case ADMIN_ROUTES.updateUser: {
        const b = updateAdminUserBodySchema.parse(body);
        const user = this.find(id);
        // Like the API: refusing to disable oneself comes before any state check.
        if (b.status === 'disabled' && user.id === SELF_ID) {
          throw new Fail(ErrorCode.CANNOT_MODIFY_SELF);
        }
        if (b.status === 'disabled' && user.status === 'active') {
          const activeAdmins = this.users.filter(
            (u) => u.role === 'admin' && u.status === 'active',
          );
          if (user.role === 'admin' && activeAdmins.length <= 1)
            throw new Fail(ErrorCode.LAST_ADMIN);
        }
        if (b.name !== undefined) user.name = b.name;
        if (b.status !== undefined && b.status !== user.status) {
          user.status = b.status;
          user.disabledAt = b.status === 'disabled' ? '2026-11-10T06:00:00.000Z' : null;
        }
        return { status: 200, value: user };
      }
      case ADMIN_ROUTES.resetPassword: {
        const b = resetAdminUserPasswordBodySchema.parse(body);
        const user = this.find(id);
        if (user.id === SELF_ID) throw new Fail(ErrorCode.CANNOT_MODIFY_SELF);
        if (!user.passwordAccount) throw new Fail(ErrorCode.CONFLICT);
        this.checkPassword(b.password, user.role);
        user.mustChangePassword = true;
        user.lockedUntil = null;
        return { status: 200, value: user };
      }
      case ADMIN_ROUTES.actAs: {
        const user = this.find(id);
        if (user.role !== 'photographer') throw new Fail(ErrorCode.NOT_FOUND);
        if (user.status !== 'active') throw new Fail(ErrorCode.CONFLICT);
        return {
          status: 200,
          value: {
            url: `https://photos.example.test/auth/act-as?code=${'c'.repeat(43)}`,
            expiresAt: '2026-11-13T05:02:00.000Z',
          },
        };
      }
      case ADMIN_ROUTES.system:
        return { status: 200, value: this.system };
      case ADMIN_ROUTES.listCashPayments: {
        const q = listCashPaymentsQuerySchema.parse(Object.fromEntries(search));
        const items = this.payments.filter(
          (p) => q.photographerId === undefined || p.photographerId === q.photographerId,
        );
        return { status: 200, value: this.page(items, q.cursor ?? null, (p) => `c-${p.id}`) };
      }
      case ADMIN_ROUTES.createCashPayment: {
        const key = headers[IDEMPOTENCY_KEY_HEADER];
        if (key === undefined) throw new Fail(ErrorCode.VALIDATION_FAILED);
        const b = createCashPaymentBodySchema.parse(body);
        const fingerprint = JSON.stringify(b);
        const seen = this.idempotency.get(key);
        if (seen !== undefined) {
          if (seen.body !== fingerprint) throw new Fail(ErrorCode.IDEMPOTENCY_KEY_REUSED);
          return { status: 201, value: seen.payment };
        }
        const target = this.find(b.photographerId);
        if (target.role !== 'photographer') throw new Fail(ErrorCode.NOT_FOUND);
        const payment: AdminCashPayment = {
          id: nextId(),
          photographerId: b.photographerId,
          amountSatang: b.amountSatang,
          paidAt: b.paidAt,
          note: b.note ?? null,
          recordedById: SELF_ID,
          createdAt: '2026-11-10T07:00:00.000Z',
        };
        this.payments.unshift(payment);
        this.idempotency.set(key, { body: fingerprint, payment });
        return { status: 201, value: payment };
      }
      default:
        throw new Fail(ErrorCode.NOT_FOUND);
    }
  }
}
