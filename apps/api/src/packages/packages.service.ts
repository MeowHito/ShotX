import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { auditLog, packageOrders, packages, photographerPackages, users } from '@shotx/db';
import {
  type AppliedPackage,
  applyPackage,
  type AuthTokenResponse,
  type CaptchaRejectReason,
  type CheckPackageCouponResponse,
  type CreatePackageOrderResponse,
  discountedPackageTotal,
  ErrorCode,
  FREE_PACKAGE_CODE,
  maskEmail,
  type MyPackageResponse,
  normalizeAccountEmail,
  PACKAGE_CHECKOUT_RETURN_PATH,
  PACKAGE_COUPON_SETTLEMENT,
  PACKAGE_GATEWAY_RETURN_PATH,
  type PackageAuditAction,
  type PackageCallback,
  type PackageOrderView,
  type PackagePaymentGateway,
  type PackagePaymentGatewayName,
  type PackagePaymentMethod,
  type PackagesResponse,
  packageExpired,
  packagesClientConfigOf,
  packageTotal,
  type RateLimitedDetails,
  SIGNUP_CONFIRM_PATH,
  type StartPackagePaymentResponse,
  TURNSTILE_ACTIONS,
} from '@shotx/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type AccountMailer } from '../auth/account-email';
import { markSignedIn, sessionUser, tokenResponse } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import { assertPasswordPolicy } from '../auth/password-policy';
import { ACCOUNT_EMAIL_INDEXES, insertPhotographerAccount } from '../auth/photographer-accounts';
import { PhotographerSignIn } from '../auth/photographer-sign-in';
import { newOpaqueToken, startSession } from '../auth/sessions';
import { SHOTX_AUTH, type ShotxAuth } from '../auth/shotx-auth';
import type { ApiConfig } from '../config';
import { type Db, isUniqueViolation, type Queryable, type Tx } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import type { EventLog } from '../infra/events';
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from '../public/captcha';
import {
  ACCOUNT_MAILER,
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  EVENT_LOG,
  KEY_VALUE_STORE,
  type KeyValueStore,
  PACKAGE_GATEWAY,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import { type CouponRow, usableCoupon } from './coupons';
import { fakePackageGatewayRef, newGatewayAttemptRef } from './gateways';
import {
  accountExistsEmail,
  packageAddedEmail,
  setPasswordEmail,
  signupLinkEmail,
  WEB_FORGOT_PASSWORD_PATH,
  WEB_SIGN_IN_PATH,
  WEB_STUDIO_PATH,
} from './package-emails';
import { photographerPackage } from './package-state';

// Packages, Free sign-up and package orders (ADR 0026). Money is integer satang; prices are
// VAT-exclusive and every amount comes from packageTotal. Emails go out after the answer (or the
// commit) and never appear in logs, events or audit rows; neither do tokens or passwords.

type PackageRow = typeof packages.$inferSelect;
type OrderRow = typeof packageOrders.$inferSelect;

/** Structured events of this module (ids and codes only). */
export const PACKAGE_EVENTS = {
  emailFailed: 'package.email_failed',
  checkoutFailed: 'package.checkout_failed',
  callbackUnparseable: 'package.callback_unparseable',
  callbackUnknownOrder: 'package.callback_unknown_order',
  callbackRefMismatch: 'package.callback_ref_mismatch',
  accountUnresolvable: 'package.account_unresolvable',
  amountMismatch: 'package.amount_mismatch',
  inquireFailed: 'package.inquire_failed',
  paymentStartFailed: 'package.payment_start_failed',
  signupDailyCap: 'package.signup_daily_cap',
} as const;

/** Sign-up emails per address are counted per hour (SIGNUP_EMAILS_PER_HOUR). */
const SIGNUP_EMAILS_WINDOW_SECONDS = 3600;
/** ... and all together per day (SIGNUP_EMAILS_PER_DAY). */
const SIGNUP_EMAILS_DAY_SECONDS = 24 * 3600;
/** GET /package-orders/:id asks the gateway at most once per order per this key's TTL. */
const inquireKey = (orderId: string) => `package-order:inquire:${orderId}`;
/** POST /package-orders/:id/pay per order (PACKAGE_PAY_RATE_PER_ORDER). */
const payKey = (orderId: string) => `package-order:pay:${orderId}`;
/** `package_orders.gateway_attempts` keeps this many attempt ids (newest first). */
export const PACKAGE_ORDER_MAX_ATTEMPTS = 10;

/**
 * The rate-limit key of one sign-up address: base64url HMAC-SHA256 of the normalized email under a
 * key derived from IP_HASH_SECRET for this purpose only (domain-separated), so the address is
 * never a key in the clear and the value matches no other HMAC of the same secret.
 */
export function signupEmailKey(secret: string, email: string): string {
  const purposeKey = createHmac('sha256', secret).update('snap:signup-email-rate:v1').digest();
  return createHmac('sha256', purposeKey).update(normalizeAccountEmail(email)).digest('base64url');
}

// The Free sign-up link token is never stored: Redis keeps its SHA-256 with the email and name.
const signupKey = (token: string) =>
  `signup-free:link:${createHash('sha256').update(token).digest('base64url')}`;

interface SignupGrant {
  e: string;
  n: string;
}

function parseSignupGrant(raw: string | null): SignupGrant | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<SignupGrant>;
    return typeof value.e === 'string' && typeof value.n === 'string'
      ? { e: value.e, n: value.n }
      : null;
  } catch {
    return null;
  }
}

/** `package_orders.access_token_hash`: lowercase hex SHA-256 of the access token. */
export function orderTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two lowercase hex SHA-256 strings. */
function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/**
 * `package_orders.request_sha256`: what makes two POST /package-orders the same request (package
 * code, normalized email, name, photographer id), so a reused Idempotency-Key is told apart from
 * a replay.
 */
export function orderRequestHash(input: {
  packageCode: string;
  email: string;
  name: string | null;
  photographerId: string | null;
  /** ADR 0030; without one the hash is the same as before coupons. */
  couponCode?: string | null | undefined;
}): string {
  const fields = [
    input.packageCode,
    normalizeAccountEmail(input.email),
    input.name ?? '',
    input.photographerId ?? '',
  ];
  const canonical = JSON.stringify(
    input.couponCode == null ? ['v1', ...fields] : ['v2', ...fields, input.couponCode],
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** A short ASCII description for the gateway's page and receipt, e.g. `Snap 7 Days`. */
function checkoutDescription(pkg: PackageRow): string {
  const ascii = pkg.name.replace(/[^\x20-\x7e]/g, '').trim();
  return `Snap ${ascii === '' ? pkg.code : ascii}`.slice(0, 64);
}

const rateLimited = (retryAfterSeconds: number) =>
  new ApiError('RATE_LIMITED', 'Too many requests; try again later', undefined, {
    'Retry-After': String(Math.max(1, retryAfterSeconds)),
  });
const signupLinkInvalid = () =>
  new ApiError(
    ErrorCode.SIGNUP_LINK_INVALID,
    'The sign-up link is invalid, expired or already used',
  );
const orderNotFound = () => new ApiError(ErrorCode.ORDER_NOT_FOUND, 'Order not found');
const emailUnavailable = () =>
  new ApiError(ErrorCode.EMAIL_UNAVAILABLE, 'This email cannot buy a package online');

/** An admin or photographer account that uses an email (ASCII case ignored). */
interface EmailAccount {
  id: string;
  role: string;
  status: 'active' | 'disabled';
  authSubject: string;
  email: string | null;
  name: string | null;
  hasPackage: boolean;
}

/**
 * Admin and photographer accounts with this email (viewers don't count), password accounts first.
 * `lock` locks the users rows (inside a transaction).
 */
async function accountsByEmail(
  q: Queryable,
  email: string,
  options: { lock?: boolean } = {},
): Promise<EmailAccount[]> {
  const query = q
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      authSubject: users.authSubject,
      email: users.email,
      name: users.name,
      hasPackage: sql<boolean>`(${photographerPackages.photographerId} IS NOT NULL)`,
    })
    .from(users)
    .leftJoin(photographerPackages, eq(photographerPackages.photographerId, users.id))
    .where(
      and(
        inArray(users.role, ['admin', 'photographer']),
        sql`lower(${users.email} COLLATE "C") = lower(${email.trim()} COLLATE "C")`,
      ),
    )
    .orderBy(
      sql`(${users.authSubject} LIKE 'password:%' OR ${users.authSubject} LIKE 'admin:%') DESC`,
      asc(users.createdAt),
    )
    .limit(10);
  return options.lock === true ? query.for('update', { of: users }) : query;
}

/** An audit_log row of PACKAGE_AUDIT_ACTIONS, in the transaction of the change. */
async function writePackageAudit(
  q: Queryable,
  entry: {
    actorId: string | null;
    action: PackageAuditAction;
    targetType: 'user' | 'package_order';
    targetId: string;
    meta: Record<string, string | number | boolean>;
    now: Date;
  },
): Promise<void> {
  await q.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    meta: entry.meta,
    createdAt: entry.now,
  });
}

/**
 * Applies `pkg` to the photographer's package row (applyPackage) under a row lock: a fresh period
 * for no row or an expired one, else an extension. A concurrent first insert is retried as an
 * update.
 */
async function applyPackageTo(
  tx: Tx,
  photographerId: string,
  pkg: Pick<PackageRow, 'id' | 'days' | 'photoLimit'>,
  now: Date,
): Promise<AppliedPackage> {
  const terms = { id: pkg.id, days: pkg.days, photoLimit: pkg.photoLimit };
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await photographerPackage(tx, photographerId, { lock: 'update' });
    const next = applyPackage(current, terms, now);
    const values = {
      packageId: next.packageId,
      startsAt: next.startsAt,
      expiresAt: next.expiresAt,
      photoLimit: next.photoLimit,
      photosUsed: next.photosUsed,
      updatedAt: now,
    };
    if (current !== null) {
      await tx
        .update(photographerPackages)
        .set(values)
        .where(eq(photographerPackages.photographerId, photographerId));
      return next;
    }
    const inserted = await tx
      .insert(photographerPackages)
      .values({ photographerId, ...values, createdAt: now })
      .onConflictDoNothing()
      .returning({ photographerId: photographerPackages.photographerId });
    if (inserted.length > 0) return next;
  }
  throw new Error('Could not apply the package');
}

/** What applying one gateway result decided. */
export type PackageCallbackOutcome =
  | {
      kind: 'paid';
      orderId: string;
      photographerId: string;
      email: string | null;
      name: string | null;
      accountCreated: boolean;
      packageName: string;
      expiresAt: Date;
      totalSatang: number;
    }
  | {
      kind:
        | 'duplicate'
        | 'pending'
        | 'failed'
        | 'amount_mismatch'
        | 'unknown_order'
        | 'ref_mismatch'
        | 'unresolvable';
    };

@Injectable()
export class PackagesService {
  /** Emails still being sent after the answer (tests await these). */
  private readonly deliveries = new Set<Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
    @Inject(SHOTX_AUTH) private readonly auth: ShotxAuth | null,
    @Inject(PACKAGE_GATEWAY) private readonly gateway: PackagePaymentGateway | null,
    @Inject(PhotographerSignIn) private readonly signIn: PhotographerSignIn,
    @Inject(EVENT_LOG) private readonly events: EventLog,
    @Inject(CAPTCHA_VERIFIER) private readonly captchaVerifier: CaptchaVerifier | null,
  ) {}

  /** Waits for every email in flight (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.deliveries]);
  }

  /** Runs `send` after the answer; a failure runs `onFailure` and is reported by event only. */
  private deliver(
    send: () => Promise<void>,
    fields: Record<string, string>,
    onFailure: () => Promise<void> = () => Promise.resolve(),
  ): void {
    const delivery = send()
      .catch(async (error: unknown) => {
        await onFailure().catch(() => undefined);
        this.events.warn(PACKAGE_EVENTS.emailFailed, {
          ...fields,
          error: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => this.deliveries.delete(delivery));
    this.deliveries.add(delivery);
  }

  private webUrl(path: string): string {
    return `${new URL(this.config.app.publicBaseUrl).origin}${path}`;
  }

  private shotx(): ShotxAuth {
    if (this.auth === null) throw notFound('Route');
    return this.auth;
  }

  private async packageByCode(q: Queryable, code: string): Promise<PackageRow | null> {
    const [row] = await q.select().from(packages).where(eq(packages.code, code)).limit(1);
    return row ?? null;
  }

  /** The active Free package; NOT_FOUND when it was switched off in the DB. */
  private async freePackage(q: Queryable): Promise<PackageRow> {
    const free = await this.packageByCode(q, FREE_PACKAGE_CODE);
    if (free === null || !free.isActive) throw notFound('Package');
    return free;
  }

  // --- GET /packages -------------------------------------------------------------------------

  async list(): Promise<PackagesResponse> {
    const vat = this.config.packages.vatRateBasisPoints;
    const rows = await this.db
      .select()
      .from(packages)
      .where(eq(packages.isActive, true))
      .orderBy(asc(packages.sortOrder), asc(packages.code));
    return {
      packages: rows.map((row) => ({
        code: row.code,
        name: row.name,
        days: row.days,
        photoLimit: row.photoLimit,
        featured: row.code === this.config.packages.featuredCode,
        free: row.code === FREE_PACKAGE_CODE,
        price: packageTotal(row.priceSatang, vat),
      })),
      currency: 'THB',
      vatRateBasisPoints: vat,
      sales: packagesClientConfigOf(this.config.packages, this.config.packageGateway),
    };
  }

  // --- POST /signup/free ---------------------------------------------------------------------

  /**
   * Free sign-up step 1. Always answers nothing (204) for a well-formed body, whether or not the
   * email has an account; RATE_LIMITED only per client IP. An email without an account gets the
   * confirmation link (SHA-256 of the token in Redis with the email and name, for
   * SIGNUP_LINK_TTL_SECONDS); a photographer's email gets "you already have an account". At most
   * SIGNUP_EMAILS_PER_HOUR emails per address (more are dropped silently). Sent after the answer.
   */
  async signupFree(
    body: { name: string; email: string; captchaToken?: string | undefined },
    client: { ipHash: string; remoteIp: string },
  ): Promise<void> {
    this.shotx();
    if (!this.mailer.available) {
      throw new ApiError('FEATURE_DISABLED', 'Sign-up by email is not available');
    }
    const { signup } = this.config.packages;
    const rate = await this.limiter.hit(
      `signup-free:ip:${client.ipHash}`,
      signup.ratePerIp.limit,
      signup.ratePerIp.windowSeconds,
    );
    if (!rate.allowed) throw rateLimited(rate.retryAfterSeconds);
    await this.assertSignupCaptcha(body.captchaToken, client.remoteIp);
    await this.freePackage(this.db);

    const quota = await this.limiter.hit(
      `signup-free:email:${signupEmailKey(this.config.consent.ipHashSecret, body.email)}`,
      signup.emailsPerHour,
      SIGNUP_EMAILS_WINDOW_SECONDS,
    );
    if (!quota.allowed) return;

    const existing = await accountsByEmail(this.db, body.email);
    // Admins get nothing: the users' sign-in page is not theirs.
    const photographer = existing.find((a) => a.role === 'photographer');
    if (existing.length > 0 && photographer === undefined) return;
    // The global cap, counted only for an email that would go out.
    const daily = await this.limiter.hit(
      'signup-free:emails:day',
      signup.emailsPerDay,
      SIGNUP_EMAILS_DAY_SECONDS,
    );
    if (!daily.allowed) {
      this.events.warn(PACKAGE_EVENTS.signupDailyCap, { limit: signup.emailsPerDay });
      return;
    }

    // The typed name is unverified: no email repeats it (it could carry someone's spam).
    if (photographer !== undefined) {
      const message = accountExistsEmail({
        to: photographer.email ?? body.email,
        signInUrl: this.webUrl(WEB_SIGN_IN_PATH),
        forgotPasswordUrl: this.webUrl(WEB_FORGOT_PASSWORD_PATH),
      });
      this.deliver(() => this.mailer.send(message), { kind: 'signup_account_exists' });
      return;
    }

    const token = newOpaqueToken();
    const key = signupKey(token);
    const grant: SignupGrant = { e: body.email, n: body.name };
    await this.store.setWithTtl(key, JSON.stringify(grant), signup.linkTtlSeconds);
    const message = signupLinkEmail({
      to: body.email,
      link: this.webUrl(`${SIGNUP_CONFIRM_PATH}#token=${token}`),
      ttlHours: Math.max(1, Math.round(signup.linkTtlSeconds / 3600)),
    });
    // The link never arrived: drop it.
    this.deliver(
      () => this.mailer.send(message),
      { kind: 'signup_link' },
      () => this.store.del(key),
    );
  }

  /**
   * With CAPTCHA_PROVIDER=turnstile, POST /signup/free needs a Turnstile token of action
   * `signup_free` (body `captchaToken`): missing or not accepted is RATE_LIMITED with
   * RateLimitedDetails `captcha` set (the shape face search answers), so the form solves the
   * widget again. Skipped with `waf` or `none`. The token is never logged.
   */
  private async assertSignupCaptcha(token: string | undefined, remoteIp: string): Promise<void> {
    if (this.config.captcha.provider !== 'turnstile' || this.captchaVerifier === null) return;
    const challenge = (rejected: CaptchaRejectReason | null) =>
      new ApiError('RATE_LIMITED', 'Solve the captcha to sign up', {
        retryAfterSeconds: 0,
        captcha: { provider: 'turnstile', action: TURNSTILE_ACTIONS.signupFree, rejected },
      } satisfies RateLimitedDetails);
    if (token === undefined) throw challenge(null);
    const verdict = await this.captchaVerifier.verify({
      token,
      remoteIp,
      action: TURNSTILE_ACTIONS.signupFree,
    });
    if (!verdict.ok) throw challenge(verdict.reason);
  }

  // --- POST /signup/free/confirm -------------------------------------------------------------

  /**
   * Free sign-up step 2. The token must be live (else SIGNUP_LINK_INVALID) and the password must
   * pass the photographer policy (PASSWORD_TOO_WEAK; the token stays usable). Then the token is
   * used up and, in one transaction: the photographer account (`created_by` null, not temporary),
   * the Free package, `account.self_signup` in audit_log and a new normal session, answered as
   * photographer sign-in and password-reset confirm do. An email that got an account meanwhile:
   * SIGNUP_LINK_INVALID.
   */
  async confirmSignup(token: string, password: string, ipHash: string): Promise<AuthTokenResponse> {
    const auth = this.shotx();
    const key = signupKey(token);
    const grant = parseSignupGrant(await this.store.get(key));
    if (grant === null) throw signupLinkInvalid();
    await assertPasswordPolicy(password, {
      minLength: auth.config.photographer.passwordMinLength,
      email: grant.e,
    });
    const free = await this.freePackage(this.db);
    // One use, even when two tabs submit at once.
    if ((await this.store.take(key)) === null) throw signupLinkInvalid();

    const passwordHash = await hashPassword(password, this.config.password.argon2id);
    const now = this.clock.now();
    let outcome;
    try {
      outcome = await this.db.transaction(async (tx) => {
        if ((await accountsByEmail(tx, grant.e)).length > 0) return null;
        const id = await insertPhotographerAccount(tx, {
          email: grant.e,
          name: grant.n,
          passwordHash,
          mustChangePassword: false,
          createdById: null,
          now,
        });
        await applyPackageTo(tx, id, free, now);
        await writePackageAudit(tx, {
          actorId: id,
          action: 'account.self_signup',
          targetType: 'user',
          targetId: id,
          meta: { package: free.code, ipHash },
          now,
        });
        await markSignedIn(tx, id, now);
        return {
          session: await startSession(tx, {
            userId: id,
            pool: 'users',
            now,
            ttlSeconds: auth.config.pools.users.refreshTokenTtlSeconds,
            amr: ['pwd'],
          }),
          user: await sessionUser(tx, id),
        };
      });
    } catch (error) {
      if (ACCOUNT_EMAIL_INDEXES.some((index) => isUniqueViolation(error, index))) {
        throw signupLinkInvalid();
      }
      throw error;
    }
    if (outcome === null) throw signupLinkInvalid();
    return tokenResponse(auth, 'users', outcome.user, outcome.session, ['pwd'], now);
  }

  // --- POST /package-orders ------------------------------------------------------------------

  /**
   * Starts a paid order (ADR 0026 §4): for the signed-in photographer (`buyerId`; `email` and
   * `name` must be absent) or anonymously (both required). Idempotent per Idempotency-Key: the
   * same request answers the same order and checkout page with a new access token (the old one
   * stops working); another request with the key is IDEMPOTENCY_KEY_REUSED. Refused:
   * PACKAGE_UNAVAILABLE (unknown, inactive, free or zero-priced), PAYMENT_UNAVAILABLE
   * (PACKAGE_GATEWAY=off), EMAIL_UNAVAILABLE (an admin's, a disabled account's or an unlimited
   * photographer's email). The order is stored `pending` before the gateway is asked; a gateway
   * failure is PAYMENT_GATEWAY_ERROR and a retry with the same key asks again.
   *
   * ADR 0030: with `couponCode` the order is priced with discountedPackageTotal and holds one of
   * the coupon's uses (checked again with the coupon row locked in the insert's transaction):
   * COUPON_INVALID, COUPON_USED_UP. A 100% coupon needs no gateway: the order (`gateway` `coupon`)
   * is settled at once and `redirectUrl` is the return page.
   */
  async createOrder(
    buyerId: string | null,
    body: {
      packageCode: string;
      email?: string | undefined;
      name?: string | undefined;
      couponCode?: string | undefined;
    },
    idempotencyKey: string,
    ipHash: string,
  ): Promise<CreatePackageOrderResponse> {
    const { orders } = this.config.packages;
    const rate = await this.limiter.hit(
      `package-order:ip:${ipHash}`,
      orders.ratePerIp.limit,
      orders.ratePerIp.windowSeconds,
    );
    if (!rate.allowed) throw rateLimited(rate.retryAfterSeconds);

    let buyer: { photographerId: string | null; email: string; name: string | null };
    if (buyerId !== null) {
      if (body.email !== undefined) {
        throw validationError(['body', 'email'], 'must be absent when signed in');
      }
      if (body.name !== undefined) {
        throw validationError(['body', 'name'], 'must be absent when signed in');
      }
      const [me] = await this.db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, buyerId))
        .limit(1);
      if (me?.email === null || me?.email === undefined) throw emailUnavailable();
      buyer = { photographerId: buyerId, email: me.email, name: me.name };
    } else {
      if (body.email === undefined) throw validationError(['body', 'email'], 'is required');
      if (body.name === undefined) throw validationError(['body', 'name'], 'is required');
      buyer = { photographerId: null, email: body.email, name: body.name };
    }
    const couponCode = body.couponCode ?? null;
    const requestSha256 = orderRequestHash({ packageCode: body.packageCode, ...buyer, couponCode });
    const replay = await this.replayOrder(idempotencyKey, requestSha256);
    if (replay !== null) return replay;

    const pkg = await this.buyablePackage(body.packageCode);
    const now = this.clock.now();
    const { holdSeconds } = this.config.packages.coupons;
    // ADR 0030: checked here for the price, and again with the row locked when the order goes in.
    const coupon =
      couponCode === null ? null : await usableCoupon(this.db, couponCode, now, holdSeconds);
    const amounts = this.orderAmounts(pkg, coupon);
    // A 100% coupon needs no gateway: the order is settled as it is created.
    const free = coupon !== null && amounts.totalSatang === 0;
    const gateway = this.gateway;
    if (!free && gateway === null) {
      throw new ApiError(ErrorCode.PAYMENT_UNAVAILABLE, 'Online payment is not open yet');
    }
    await this.assertEmailCanBuy(buyer);

    const accessToken = newOpaqueToken();
    const values = {
      packageId: pkg.id,
      photographerId: buyer.photographerId,
      email: buyer.email,
      name: buyer.name,
      priceSatang: amounts.priceSatang,
      vatSatang: amounts.vatSatang,
      totalSatang: amounts.totalSatang,
      vatRateBasisPoints: amounts.vatRateBasisPoints,
      couponId: coupon?.id ?? null,
      couponCode: coupon?.code ?? null,
      discountSatang: amounts.discountSatang,
      gateway: free || gateway === null ? PACKAGE_COUPON_SETTLEMENT : gateway.name,
      redirectUrl: free ? this.webUrl(PACKAGE_CHECKOUT_RETURN_PATH) : null,
      accessTokenHash: orderTokenHash(accessToken),
      idempotencyKey,
      requestSha256,
      createdAt: now,
      updatedAt: now,
    };
    let order: OrderRow | undefined;
    try {
      [order] =
        coupon === null
          ? await this.db.insert(packageOrders).values(values).returning()
          : await this.db.transaction(async (tx) => {
              // The coupon locked: two orders at once can't both take its last use.
              await usableCoupon(tx, coupon.code, now, holdSeconds, { lock: true });
              return tx.insert(packageOrders).values(values).returning();
            });
    } catch (error) {
      if (!isUniqueViolation(error, 'package_orders_idempotency_key_unique')) throw error;
      // The same key raced in from another request.
      const raced = await this.replayOrder(idempotencyKey, requestSha256);
      if (raced !== null) return raced;
      throw error;
    }
    if (order === undefined) throw new Error('Order insert returned no row');
    if (free) await this.settleFreeOrder(order);
    return this.checkout(order, accessToken, pkg);
  }

  /** PACKAGE_UNAVAILABLE unless `code` can be bought online (active, not free, priced). */
  private async buyablePackage(code: string): Promise<PackageRow> {
    const pkg = await this.packageByCode(this.db, code);
    if (pkg === null || !pkg.isActive || pkg.code === FREE_PACKAGE_CODE || pkg.priceSatang <= 0) {
      throw new ApiError(ErrorCode.PACKAGE_UNAVAILABLE, 'This package cannot be bought online');
    }
    return pkg;
  }

  /** The order amounts of `pkg`, with the coupon's discount when there is one (ADR 0030). */
  private orderAmounts(pkg: PackageRow, coupon: CouponRow | null) {
    const rate = this.config.packages.vatRateBasisPoints;
    return coupon === null
      ? { ...packageTotal(pkg.priceSatang, rate), discountSatang: 0 }
      : discountedPackageTotal(pkg.priceSatang, coupon.percentOff, rate);
  }

  /**
   * ADR 0030: a 100% coupon's order, settled through the paid-callback transaction (account,
   * package, audit, emails) with nothing to pay. Again for a replay of one still pending.
   */
  private async settleFreeOrder(order: OrderRow): Promise<void> {
    if (order.gateway !== PACKAGE_COUPON_SETTLEMENT || order.totalSatang !== 0) return;
    if (order.status !== 'pending') return;
    await this.applyCallback(PACKAGE_COUPON_SETTLEMENT, {
      gatewayRef: `coupon-${order.id}`,
      orderId: order.id,
      status: 'paid',
      amountSatang: 0,
    });
  }

  // --- POST /package-coupons/check (ADR 0030) ---------------------------------------------------

  /**
   * What `couponCode` makes `packageCode` cost, for the buy dialog. Holds nothing; the order takes
   * a use when it is created. Rate-limited per IP (PACKAGE_COUPON_CHECK_RATE_PER_IP), so codes
   * can't be guessed quickly.
   */
  async checkCoupon(
    body: { packageCode: string; couponCode: string },
    ipHash: string,
  ): Promise<CheckPackageCouponResponse> {
    const rule = this.config.packages.coupons.checkRatePerIp;
    const rate = await this.limiter.hit(
      `package-coupon:ip:${ipHash}`,
      rule.limit,
      rule.windowSeconds,
    );
    if (!rate.allowed) throw rateLimited(rate.retryAfterSeconds);
    const pkg = await this.buyablePackage(body.packageCode);
    const coupon = await usableCoupon(
      this.db,
      body.couponCode,
      this.clock.now(),
      this.config.packages.coupons.holdSeconds,
    );
    const amounts = this.orderAmounts(pkg, coupon);
    return {
      couponCode: coupon.code,
      percentOff: coupon.percentOff,
      listTotalSatang: packageTotal(pkg.priceSatang, amounts.vatRateBasisPoints).totalSatang,
      price: {
        priceSatang: amounts.priceSatang,
        vatSatang: amounts.vatSatang,
        totalSatang: amounts.totalSatang,
        vatRateBasisPoints: amounts.vatRateBasisPoints,
      },
    };
  }

  /**
   * EMAIL_UNAVAILABLE unless the buyer's email may buy: the signed-in photographer must have a
   * package (unlimited accounts don't need one); an anonymous email must not be an admin's, a
   * disabled account's or an unlimited photographer's (any other photographer with a package
   * gets it added when paid).
   */
  private async assertEmailCanBuy(buyer: {
    photographerId: string | null;
    email: string;
  }): Promise<void> {
    if (buyer.photographerId !== null) {
      if ((await photographerPackage(this.db, buyer.photographerId)) === null) {
        throw emailUnavailable();
      }
      return;
    }
    const accounts = await accountsByEmail(this.db, buyer.email);
    if (accounts.some((a) => a.role === 'admin' || a.status !== 'active' || !a.hasPackage)) {
      throw emailUnavailable();
    }
  }

  /**
   * The order of an Idempotency-Key: null when the key is new; IDEMPOTENCY_KEY_REUSED for another
   * request; else the same order with a new access token (only its hash is stored).
   */
  private async replayOrder(
    idempotencyKey: string,
    requestSha256: string,
  ): Promise<CreatePackageOrderResponse | null> {
    const [existing] = await this.db
      .select()
      .from(packageOrders)
      .where(eq(packageOrders.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing === undefined) return null;
    if (existing.requestSha256 !== requestSha256) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was used before for another order',
      );
    }
    const accessToken = newOpaqueToken();
    await this.db
      .update(packageOrders)
      .set({ accessTokenHash: orderTokenHash(accessToken), updatedAt: this.clock.now() })
      .where(eq(packageOrders.id, existing.id));
    const [pkg] = await this.db
      .select()
      .from(packages)
      .where(eq(packages.id, existing.packageId))
      .limit(1);
    if (pkg === undefined) throw new Error('Order without its package');
    await this.settleFreeOrder(existing);
    return this.checkout(existing, accessToken, pkg);
  }

  /**
   * The order's checkout page: the stored one, or a new one from the gateway (stored with the
   * gateway's reference). The callback URL is this API on PUBLIC_BASE_URL.
   */
  private async checkout(
    order: OrderRow,
    accessToken: string,
    pkg: PackageRow,
  ): Promise<CreatePackageOrderResponse> {
    if (order.redirectUrl !== null) {
      return { orderId: order.id, accessToken, redirectUrl: order.redirectUrl };
    }
    const gateway = this.gateway;
    if (gateway === null || gateway.name !== order.gateway) {
      throw new ApiError(ErrorCode.PAYMENT_UNAVAILABLE, 'Online payment is not open yet');
    }
    let result;
    try {
      result = await gateway.createCheckout({
        orderId: order.id,
        amountSatang: order.totalSatang,
        currency: 'THB',
        description: checkoutDescription(pkg),
        returnUrl: this.webUrl(PACKAGE_CHECKOUT_RETURN_PATH),
        callbackUrl: this.webUrl(`/api/package-payments/webhooks/${gateway.name}`),
        customerEmail: order.email,
      });
    } catch (error) {
      this.events.warn(PACKAGE_EVENTS.checkoutFailed, {
        orderId: order.id,
        gateway: gateway.name,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new ApiError('PAYMENT_GATEWAY_ERROR', 'The payment gateway is not available');
    }
    await this.db
      .update(packageOrders)
      .set({
        redirectUrl: result.redirectUrl,
        ...(order.gatewayRef === null && result.gatewayRef !== null
          ? { gatewayRef: result.gatewayRef }
          : {}),
        updatedAt: this.clock.now(),
      })
      .where(eq(packageOrders.id, order.id));
    return { orderId: order.id, accessToken, redirectUrl: result.redirectUrl };
  }

  // --- GET /package-orders/:id, POST /package-orders/:id/fake-result --------------------------

  /** The order of `id` when `token` is its access token (constant-time); else ORDER_NOT_FOUND. */
  private async orderByToken(id: string, token: string): Promise<OrderRow> {
    const [order] = await this.db
      .select()
      .from(packageOrders)
      .where(eq(packageOrders.id, id.toLowerCase()))
      .limit(1);
    const presented = orderTokenHash(token);
    // Compare against something either way, so an unknown id takes as long as a wrong token.
    const matches = hashesMatch(order?.accessTokenHash ?? presented.replace(/./g, '0'), presented);
    if (order === undefined || !matches) throw orderNotFound();
    return order;
  }

  /** The order as /checkout/return shows it (packageOrderViewSchema). */
  private async view(orderId: string): Promise<PackageOrderView> {
    const [row] = await this.db
      .select({ order: packageOrders, code: packages.code, name: packages.name })
      .from(packageOrders)
      .innerJoin(packages, eq(packages.id, packageOrders.packageId))
      .where(eq(packageOrders.id, orderId))
      .limit(1);
    if (row === undefined) throw orderNotFound();
    const { order } = row;
    // The expiry belongs to the account: shown when this order created it, or when its own
    // signed-in owner placed the order; never to an anonymous buyer who typed an existing
    // account's email. A signed-in order's request hash was made with its photographer id.
    const ownAccount =
      order.photographerId !== null &&
      (order.accountCreated ||
        orderRequestHash({
          packageCode: row.code,
          email: order.email,
          name: order.name,
          photographerId: order.photographerId,
          couponCode: order.couponCode,
        }) === order.requestSha256);
    const current =
      order.status === 'paid' && order.photographerId !== null && ownAccount
        ? await photographerPackage(this.db, order.photographerId)
        : null;
    return {
      status: order.status,
      packageCode: row.code,
      packageName: row.name,
      totalSatang: order.totalSatang,
      emailMasked: maskEmail(order.email),
      accountCreated: order.accountCreated,
      expiresAt: current?.expiresAt.toISOString() ?? null,
      paymentMethods: this.payableMethods(order),
      coupon:
        order.couponCode === null
          ? null
          : {
              code: order.couponCode,
              listTotalSatang: packageTotal(
                order.priceSatang + order.discountSatang,
                order.vatRateBasisPoints,
              ).totalSatang,
            },
    };
  }

  /** ADR 0029: what the pay page may offer for `order` now (packageOrderViewSchema). */
  private payableMethods(order: OrderRow): PackagePaymentMethod[] {
    const gateway = this.gateway;
    if (gateway === null || gateway.name !== order.gateway) return [];
    if (order.status !== 'pending' && order.status !== 'failed') return [];
    if (gateway.startPayment === undefined) return [];
    return [...(gateway.paymentMethods ?? [])];
  }

  // --- POST /package-orders/:id/pay (ADR 0029) --------------------------------------------------

  /**
   * One payment attempt from the pay page: a new gateway attempt id is stored in
   * `gateway_attempts` (newest first, at most PACKAGE_ORDER_MAX_ATTEMPTS) before the gateway is
   * called, so GET /package-orders/:id can ask about it even if the answer is lost.
   */
  async startPayment(
    id: string,
    token: string,
    method: PackagePaymentMethod,
  ): Promise<StartPackagePaymentResponse> {
    const order = await this.orderByToken(id, token);
    const gateway = this.gateway;
    if (
      gateway === null ||
      gateway.startPayment === undefined ||
      !this.payableMethods(order).includes(method)
    ) {
      throw new ApiError(ErrorCode.PAYMENT_UNAVAILABLE, 'This order can not be paid this way');
    }
    const rule = this.config.packages.orders.payRatePerOrder;
    const rate = await this.limiter.hit(payKey(order.id), rule.limit, rule.windowSeconds);
    if (!rate.allowed) throw rateLimited(rate.retryAfterSeconds);

    const [pkg] = await this.db
      .select()
      .from(packages)
      .where(eq(packages.id, order.packageId))
      .limit(1);
    if (pkg === undefined) throw new Error('Order without its package');
    const attemptRef = newGatewayAttemptRef();
    await this.db
      .update(packageOrders)
      .set({
        gatewayAttempts: sql`(array_prepend(${attemptRef}::text, ${packageOrders.gatewayAttempts}))[1:${sql.raw(String(PACKAGE_ORDER_MAX_ATTEMPTS))}]`,
        updatedAt: this.clock.now(),
      })
      .where(eq(packageOrders.id, order.id));
    try {
      const start = await gateway.startPayment({
        orderId: order.id,
        attemptRef,
        method,
        amountSatang: order.totalSatang,
        currency: 'THB',
        description: checkoutDescription(pkg),
        returnUrl: this.webUrl(PACKAGE_GATEWAY_RETURN_PATH),
      });
      return start.method === 'qr'
        ? {
            method: 'qr',
            qrImage: `data:image/png;base64,${start.qrPngBase64}`,
            expiresAt: start.expiresAt.toISOString(),
          }
        : { method: 'card', redirectUrl: start.redirectUrl };
    } catch (error) {
      this.events.warn(PACKAGE_EVENTS.paymentStartFailed, {
        orderId: order.id,
        gateway: gateway.name,
        method,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      throw new ApiError('PAYMENT_GATEWAY_ERROR', 'The payment gateway is not available');
    }
  }

  /**
   * GET /package-orders/:id. While the order is pending for longer than
   * PACKAGE_ORDER_INQUIRE_AFTER_SECONDS and the adapter can `inquire`, the gateway is asked (at
   * most once per order per PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS) and a final answer is applied
   * like a callback (a failure to ask is only logged).
   */
  async getOrder(id: string, token: string): Promise<PackageOrderView> {
    const order = await this.orderByToken(id, token);
    const gateway = this.gateway;
    const pendingMs = this.clock.now().getTime() - order.createdAt.getTime();
    if (
      order.status === 'pending' &&
      (order.gatewayRef !== null || order.gatewayAttempts.length > 0) &&
      gateway?.inquire !== undefined &&
      gateway.name === order.gateway &&
      pendingMs >= this.config.packages.orders.inquireAfterSeconds * 1000 &&
      // At most once per order per PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS, however often it polls.
      (
        await this.limiter.hit(
          inquireKey(order.id),
          1,
          this.config.packages.orders.inquireIntervalSeconds,
        )
      ).allowed
    ) {
      try {
        const answer = await gateway.inquire({
          orderId: order.id,
          gatewayRef: order.gatewayRef,
          attemptRefs: order.gatewayAttempts,
        });
        if (answer !== null && answer.orderId === order.id && answer.status !== 'pending') {
          await this.applyCallback(gateway.name, answer);
        }
      } catch (error) {
        this.events.warn(PACKAGE_EVENTS.inquireFailed, {
          orderId: order.id,
          gateway: gateway.name,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return this.view(order.id);
  }

  /** NOT_FOUND unless PACKAGE_GATEWAY=fake (the fake-result route exists only then). */
  assertFakeGateway(): void {
    if (this.gateway === null || this.gateway.name !== 'fake') throw notFound('Route');
  }

  /**
   * POST /package-orders/:id/fake-result: the fake gateway's paid / failed buttons, applied like a
   * callback for the order's full amount. NOT_FOUND unless PACKAGE_GATEWAY=fake.
   */
  async fakeResult(
    id: string,
    token: string,
    result: 'paid' | 'failed',
  ): Promise<PackageOrderView> {
    this.assertFakeGateway();
    const order = await this.orderByToken(id, token);
    if (order.gateway !== 'fake') throw orderNotFound();
    await this.applyCallback('fake', {
      gatewayRef: order.gatewayRef ?? fakePackageGatewayRef(order.id),
      orderId: order.id,
      status: result,
      amountSatang: order.totalSatang,
    });
    return this.view(order.id);
  }

  // --- POST /package-payments/webhooks/:gateway ------------------------------------------------

  /**
   * A gateway callback: NOT_FOUND unless `:gateway` is the configured PACKAGE_GATEWAY; the adapter
   * verifies the raw body first (WEBHOOK_SIGNATURE_INVALID), then parses it (VALIDATION_FAILED for
   * a body it can't read) and the result is applied (applyCallback). Answers 2xx for a verified
   * callback, also a duplicate or one for an unknown order (reported by event, never retried).
   */
  async webhook(
    gatewayName: PackagePaymentGatewayName,
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    const gateway = this.gateway;
    if (gateway === null || gateway.name !== gatewayName) throw notFound('Webhook');
    const request = { rawBody: new Uint8Array(rawBody), headers };
    if (!(await gateway.verifyCallback(request))) {
      throw new ApiError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid');
    }
    let callback: PackageCallback;
    try {
      callback = gateway.parseCallback(request);
    } catch {
      this.events.warn(PACKAGE_EVENTS.callbackUnparseable, { gateway: gateway.name });
      throw new ApiError('VALIDATION_FAILED', 'The callback body could not be read', {
        issues: [{ path: ['body'], message: 'is not a callback this gateway sends' }],
      });
    }
    await this.applyCallback(gateway.name, callback);
  }

  /**
   * Applies one gateway result (webhook, fake result or inquiry) in ONE transaction with the order
   * locked FOR UPDATE (ADR 0026 §4):
   * - already `paid` (or `amount_mismatch`, which the operator settles): nothing (idempotent);
   * - `failed`: a pending order becomes `failed`;
   * - `paid` with another amount than `total_satang`: `amount_mismatch`, audited, nothing applied;
   * - `paid`: the account is the order's photographer, else an existing photographer with the
   *   email, else a new one (`created_by` null, a random password hash nobody knows); the package
   *   is applied; `paid`, `paid_at`, `applied_at`; `package.order_paid` audited. A failed or old
   *   pending order still applies: money received always counts.
   * After the commit a new account gets the "ตั้งรหัสผ่าน" email, an existing one "เพิ่มแพ็กเกจแล้ว".
   */
  async applyCallback(
    gatewayName: PackagePaymentGatewayName | typeof PACKAGE_COUPON_SETTLEMENT,
    callback: PackageCallback,
  ): Promise<PackageCallbackOutcome> {
    if (callback.status === 'pending') return { kind: 'pending' };
    const orderId = callback.orderId.toLowerCase();
    const where = and(eq(packageOrders.id, orderId), eq(packageOrders.gateway, gatewayName));
    const [peek] = await this.db
      .select({ status: packageOrders.status, photographerId: packageOrders.photographerId })
      .from(packageOrders)
      .where(where)
      .limit(1);
    if (peek === undefined) {
      this.events.warn(PACKAGE_EVENTS.callbackUnknownOrder, { gateway: gatewayName });
      return { kind: 'unknown_order' };
    }
    // argon2id is slow: hash a would-be new account's unusable password before the transaction.
    const unusableHash =
      callback.status === 'paid' && peek.status !== 'paid' && peek.photographerId === null
        ? await hashPassword(newOpaqueToken(), this.config.password.argon2id)
        : null;
    const now = this.clock.now();

    const outcome = await this.db.transaction(async (tx): Promise<PackageCallbackOutcome> => {
      const [order] = await tx.select().from(packageOrders).where(where).for('update');
      if (order === undefined) return { kind: 'unknown_order' };
      if (order.gatewayRef !== null && order.gatewayRef !== callback.gatewayRef) {
        return { kind: 'ref_mismatch' };
      }
      const gatewayRef = order.gatewayRef ?? callback.gatewayRef;
      if (order.status === 'paid' || order.status === 'amount_mismatch') {
        return { kind: 'duplicate' };
      }
      if (callback.status === 'failed') {
        if (order.status === 'pending') {
          await tx
            .update(packageOrders)
            .set({ status: 'failed', gatewayRef, updatedAt: now })
            .where(eq(packageOrders.id, order.id));
        }
        return { kind: 'failed' };
      }
      const [pkg] = await tx
        .select()
        .from(packages)
        .where(eq(packages.id, order.packageId))
        .limit(1);
      if (pkg === undefined) throw new Error('Order without its package');
      if (callback.amountSatang !== order.totalSatang) {
        await tx
          .update(packageOrders)
          .set({ status: 'amount_mismatch', gatewayRef, updatedAt: now })
          .where(eq(packageOrders.id, order.id));
        await writePackageAudit(tx, {
          actorId: order.photographerId,
          action: 'package.order_amount_mismatch',
          targetType: 'package_order',
          targetId: order.id,
          meta: {
            orderId: order.id,
            package: pkg.code,
            totalSatang: order.totalSatang,
            paidSatang: callback.amountSatang,
          },
          now,
        });
        return { kind: 'amount_mismatch' };
      }

      const account = await this.resolveAccount(tx, order, unusableHash, now);
      if (account === null) return { kind: 'unresolvable' };
      const applied = await applyPackageTo(tx, account.id, pkg, now);
      await tx
        .update(packageOrders)
        .set({
          status: 'paid',
          paidAt: now,
          appliedAt: now,
          photographerId: account.id,
          accountCreated: account.created,
          gatewayRef,
          updatedAt: now,
        })
        .where(eq(packageOrders.id, order.id));
      await writePackageAudit(tx, {
        actorId: account.id,
        action: 'package.order_paid',
        targetType: 'package_order',
        targetId: order.id,
        meta: {
          orderId: order.id,
          package: pkg.code,
          totalSatang: order.totalSatang,
          accountCreated: account.created,
        },
        now,
      });
      return {
        kind: 'paid',
        orderId: order.id,
        photographerId: account.id,
        email: account.email,
        name: account.name,
        accountCreated: account.created,
        packageName: pkg.name,
        expiresAt: applied.expiresAt,
        totalSatang: order.totalSatang,
      };
    });

    switch (outcome.kind) {
      case 'paid':
        this.sendPaidEmail(outcome);
        break;
      case 'amount_mismatch':
        this.events.warn(PACKAGE_EVENTS.amountMismatch, { orderId, gateway: gatewayName });
        break;
      case 'ref_mismatch':
        this.events.warn(PACKAGE_EVENTS.callbackRefMismatch, { orderId, gateway: gatewayName });
        break;
      case 'unresolvable':
        this.events.warn(PACKAGE_EVENTS.accountUnresolvable, { orderId, gateway: gatewayName });
        break;
      case 'unknown_order':
        this.events.warn(PACKAGE_EVENTS.callbackUnknownOrder, { gateway: gatewayName });
        break;
      default:
        break;
    }
    return outcome;
  }

  /**
   * The account a paid order goes to, locked: the order's photographer; else the photographer
   * account with the order's email (password accounts first); else a new photographer account.
   * Null (the order stays pending, `package.account_unresolvable` for the operator) when the
   * account can't take a package: an admin's email (an admin can't have a package, and the email
   * can't name a second password account), a disabled account, or an unlimited photographer
   * without a package row (ADR 0010 accounts: applying a package would limit them).
   */
  private async resolveAccount(
    tx: Tx,
    order: OrderRow,
    unusableHash: string | null,
    now: Date,
  ): Promise<{ id: string; email: string | null; name: string | null; created: boolean } | null> {
    if (order.photographerId !== null) {
      const [row] = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          status: users.status,
          hasPackage: sql<boolean>`(${photographerPackages.photographerId} IS NOT NULL)`,
        })
        .from(users)
        .leftJoin(photographerPackages, eq(photographerPackages.photographerId, users.id))
        .where(eq(users.id, order.photographerId))
        .for('update', { of: users });
      if (row?.role !== 'photographer' || row.status !== 'active' || !row.hasPackage) {
        return null;
      }
      return { id: row.id, email: row.email, name: row.name, created: false };
    }
    const accounts = await accountsByEmail(tx, order.email, { lock: true });
    if (accounts.some((a) => a.role === 'admin')) return null;
    const photographer = accounts.find((a) => a.role === 'photographer');
    if (photographer !== undefined) {
      if (photographer.status !== 'active' || !photographer.hasPackage) return null;
      return {
        id: photographer.id,
        email: photographer.email,
        name: photographer.name,
        created: false,
      };
    }
    const id = await insertPhotographerAccount(tx, {
      email: order.email,
      name: order.name,
      passwordHash:
        unusableHash ?? (await hashPassword(newOpaqueToken(), this.config.password.argon2id)),
      mustChangePassword: false,
      createdById: null,
      now,
    });
    return { id, email: order.email, name: order.name, created: true };
  }

  /** After a paid order commits: "ตั้งรหัสผ่าน" for a new account, else "เพิ่มแพ็กเกจแล้ว". */
  private sendPaidEmail(outcome: Extract<PackageCallbackOutcome, { kind: 'paid' }>): void {
    const to = outcome.email;
    if (!this.mailer.available || to === null) return;
    const summary = {
      to,
      name: outcome.name,
      packageName: outcome.packageName,
      expiresAt: outcome.expiresAt,
      totalSatang: outcome.totalSatang,
    };
    if (!outcome.accountCreated) {
      const message = packageAddedEmail({ ...summary, studioUrl: this.webUrl(WEB_STUDIO_PATH) });
      this.deliver(() => this.mailer.send(message), {
        kind: 'package_added',
        orderId: outcome.orderId,
      });
      return;
    }
    const ttlSeconds = this.config.packages.orders.setPasswordTtlSeconds;
    let discard: () => Promise<void> = () => Promise.resolve();
    this.deliver(
      async () => {
        const issued = await this.signIn.issuePasswordSetLink(outcome.photographerId, ttlSeconds);
        if (issued === null) return;
        discard = issued.discard;
        await this.mailer.send(
          setPasswordEmail({
            ...summary,
            link: issued.link,
            ttlDays: Math.max(1, Math.round(ttlSeconds / 86_400)),
          }),
        );
      },
      { kind: 'set_password', orderId: outcome.orderId },
      () => discard(),
    );
  }

  // --- GET /me/package -----------------------------------------------------------------------

  /** The photographer's package, or null when the account is unlimited (no row). */
  async myPackage(photographerId: string): Promise<MyPackageResponse> {
    const [row] = await this.db
      .select({
        code: packages.code,
        name: packages.name,
        startsAt: photographerPackages.startsAt,
        expiresAt: photographerPackages.expiresAt,
        photoLimit: photographerPackages.photoLimit,
        photosUsed: photographerPackages.photosUsed,
      })
      .from(photographerPackages)
      .innerJoin(packages, eq(packages.id, photographerPackages.packageId))
      .where(eq(photographerPackages.photographerId, photographerId))
      .limit(1);
    if (row === undefined) return null;
    return {
      code: row.code,
      name: row.name,
      startsAt: row.startsAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      photoLimit: row.photoLimit,
      photosUsed: row.photosUsed,
      expired: packageExpired(row, this.clock.now()),
    };
  }
}
