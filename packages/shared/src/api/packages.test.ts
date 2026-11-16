import { describe, expect, it } from 'vitest';
import { packageTotal } from '../billing/money';
import { SHARE_UNAVAILABLE_REASONS } from '../domain';
import {
  ERROR_DETAILS_SCHEMAS,
  ERROR_HTTP_STATUS,
  ErrorCode,
  shareExpiredDetailsSchema,
} from '../errors';
import { driveUsageResponseSchema } from './drive';
import {
  createPackageOrderBodySchema,
  createPackageOrderHeadersSchema,
  createPackageOrderResponseSchema,
  myPackageResponseSchema,
  packageOrderCookieValue,
  packageOrderFakeResultBodySchema,
  packageOrderTokenHeadersSchema,
  packageOrderViewSchema,
  packagesResponseSchema,
  packageWebhookParamsSchema,
  parsePackageOrderCookie,
  signupFreeBodySchema,
  signupFreeConfirmBodySchema,
} from './packages';
import {
  ALL_ROUTES,
  apiPath,
  DRIVE_ROUTES,
  PACKAGE_ROUTES,
  SHARE_ROUTES,
  UPLOAD_ROUTES,
} from './routes';

const token = 'A'.repeat(43);
const orderId = '0195f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f1a';

describe('package error codes (ADR 0026 §7)', () => {
  it('has every new code with its status', () => {
    expect({
      PLAN_EXPIRED: ERROR_HTTP_STATUS.PLAN_EXPIRED,
      PHOTO_LIMIT_REACHED: ERROR_HTTP_STATUS.PHOTO_LIMIT_REACHED,
      PACKAGE_UNAVAILABLE: ERROR_HTTP_STATUS.PACKAGE_UNAVAILABLE,
      PAYMENT_UNAVAILABLE: ERROR_HTTP_STATUS.PAYMENT_UNAVAILABLE,
      EMAIL_UNAVAILABLE: ERROR_HTTP_STATUS.EMAIL_UNAVAILABLE,
      SIGNUP_LINK_INVALID: ERROR_HTTP_STATUS.SIGNUP_LINK_INVALID,
      ORDER_NOT_FOUND: ERROR_HTTP_STATUS.ORDER_NOT_FOUND,
    }).toEqual({
      PLAN_EXPIRED: 403,
      PHOTO_LIMIT_REACHED: 403,
      PACKAGE_UNAVAILABLE: 404,
      PAYMENT_UNAVAILABLE: 409,
      EMAIL_UNAVAILABLE: 409,
      SIGNUP_LINK_INVALID: 400,
      ORDER_NOT_FOUND: 404,
    });
  });

  it('types the details of PLAN_EXPIRED and PHOTO_LIMIT_REACHED', () => {
    expect(
      ERROR_DETAILS_SCHEMAS.PLAN_EXPIRED.parse({ expiresAt: '2026-11-19T03:00:00.000Z' }),
    ).toEqual({ expiresAt: '2026-11-19T03:00:00.000Z' });
    expect(
      ERROR_DETAILS_SCHEMAS.PHOTO_LIMIT_REACHED.safeParse({
        photoLimit: 100,
        photosUsed: 100,
        requested: 1,
      }).success,
    ).toBe(true);
  });

  it("closes an expired photographer's shares with reason plan_expired", () => {
    expect(SHARE_UNAVAILABLE_REASONS).toContain('plan_expired');
    expect(shareExpiredDetailsSchema.parse({ reason: 'plan_expired' })).toEqual({
      reason: 'plan_expired',
    });
  });

  it('lists PLAN_EXPIRED / PHOTO_LIMIT_REACHED on the routes the ADR blocks', () => {
    expect(UPLOAD_ROUTES.init.errors).toEqual(
      expect.arrayContaining([ErrorCode.PLAN_EXPIRED, ErrorCode.PHOTO_LIMIT_REACHED]),
    );
    expect(SHARE_ROUTES.create.errors).toContain(ErrorCode.PLAN_EXPIRED);
    expect(SHARE_ROUTES.update.errors).toContain(ErrorCode.PLAN_EXPIRED);
    expect(DRIVE_ROUTES.updateFaceIndex.errors).toContain(ErrorCode.PLAN_EXPIRED);
  });

  it('lets GET /drive/usage say a package blocks uploads', () => {
    const usage = {
      usedBytes: 0,
      reservedBytes: 0,
      quotaBytes: null,
      availableBytes: null,
      trashBytes: 0,
      subscription: null,
    };
    for (const blocked of ['PLAN_EXPIRED', 'PHOTO_LIMIT_REACHED', null]) {
      expect(
        driveUsageResponseSchema.safeParse({ ...usage, uploadsBlockedBy: blocked }).success,
        String(blocked),
      ).toBe(true);
    }
  });
});

describe('package routes (ADR 0026)', () => {
  it('has the contract of every route', () => {
    const summary = Object.fromEntries(
      Object.entries(PACKAGE_ROUTES).map(([key, r]) => [
        key,
        `${r.method} ${r.path} ${r.status} ${r.auth}${'bffKey' in r ? `/${r.bffKey}` : ''}`,
      ]),
    );
    expect(summary).toEqual({
      list: 'GET /packages 200 public',
      signupFree: 'POST /signup/free 204 bff/users',
      signupFreeConfirm: 'POST /signup/free/confirm 200 bff/users',
      createOrder: 'POST /package-orders 201 bff/users',
      getOrder: 'GET /package-orders/:id 200 bff/users',
      fakeResult: 'POST /package-orders/:id/fake-result 200 bff/users',
      webhook: 'POST /package-payments/webhooks/:gateway 200 webhook',
      myPackage: 'GET /me/package 200 photographer',
    });
    expect(PACKAGE_ROUTES.createOrder.optionalAuth).toBe('photographer');
    expect(ALL_ROUTES.filter((r) => r.optionalAuth !== undefined)).toEqual([
      PACKAGE_ROUTES.createOrder,
    ]);
    expect(PACKAGE_ROUTES.webhook.rawBody).toBe(true);
    expect(apiPath(PACKAGE_ROUTES.getOrder, { id: orderId })).toBe(
      `/api/package-orders/${orderId}`,
    );
  });

  it('answers NOT_FOUND from the routes PACKAGE_SALES=off closes', () => {
    for (const route of [
      PACKAGE_ROUTES.signupFree,
      PACKAGE_ROUTES.signupFreeConfirm,
      PACKAGE_ROUTES.createOrder,
    ]) {
      expect(route.errors, route.path).toContain(ErrorCode.NOT_FOUND);
    }
    expect(PACKAGE_ROUTES.createOrder.errors).toEqual(
      expect.arrayContaining([
        ErrorCode.PACKAGE_UNAVAILABLE,
        ErrorCode.PAYMENT_UNAVAILABLE,
        ErrorCode.EMAIL_UNAVAILABLE,
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        ErrorCode.ACCOUNT_DISABLED,
        ErrorCode.PASSWORD_CHANGE_REQUIRED,
      ]),
    );
    expect(PACKAGE_ROUTES.signupFreeConfirm.errors).toContain(ErrorCode.SIGNUP_LINK_INVALID);
    expect(PACKAGE_ROUTES.getOrder.errors).toContain(ErrorCode.ORDER_NOT_FOUND);
  });

  it('validates the sign-up bodies', () => {
    expect(signupFreeBodySchema.parse({ name: ' สมชาย ', email: ' a@example.com ' })).toEqual({
      name: 'สมชาย',
      email: 'a@example.com',
    });
    expect(signupFreeBodySchema.safeParse({ email: 'a@example.com' }).success).toBe(false);
    expect(
      signupFreeBodySchema.safeParse({ name: 'A', email: 'a@example.com', role: 'admin' }).success,
    ).toBe(false);
    expect(
      signupFreeConfirmBodySchema.safeParse({ token, password: 'correct horse battery' }).success,
    ).toBe(true);
    expect(
      signupFreeConfirmBodySchema.safeParse({ token: 'short', password: 'x'.repeat(12) }).success,
    ).toBe(false);
  });

  it('validates the order request, response and order view', () => {
    expect(createPackageOrderHeadersSchema.safeParse({}).success).toBe(false);
    expect(createPackageOrderHeadersSchema.safeParse({ 'idempotency-key': 'a1b2c3' }).success).toBe(
      true,
    );
    expect(createPackageOrderBodySchema.parse({ packageCode: 'd7' })).toEqual({
      packageCode: 'd7',
    });
    expect(
      createPackageOrderBodySchema.safeParse({
        packageCode: 'd7',
        email: 'buyer@example.com',
        name: 'ผู้ซื้อ',
      }).success,
    ).toBe(true);
    expect(createPackageOrderBodySchema.safeParse({ packageCode: '7 Days' }).success).toBe(false);
    expect(
      createPackageOrderBodySchema.safeParse({ packageCode: 'd7', photographerId: orderId })
        .success,
    ).toBe(false);
    expect(
      createPackageOrderResponseSchema.safeParse({
        orderId,
        accessToken: token,
        redirectUrl: 'https://pay.mpay.example/checkout/abc',
      }).success,
    ).toBe(true);
    expect(
      createPackageOrderResponseSchema.safeParse({
        orderId,
        accessToken: token,
        redirectUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
    expect(packageOrderTokenHeadersSchema.safeParse({ 'x-order-token': token }).success).toBe(true);
    expect(packageOrderTokenHeadersSchema.safeParse({}).success).toBe(false);
    for (const status of ['pending', 'paid', 'failed', 'amount_mismatch']) {
      expect(
        packageOrderViewSchema.safeParse({
          status,
          packageCode: 'd7',
          packageName: '7 Days',
          totalSatang: 64_093,
          emailMasked: 'b***@example.com',
          accountCreated: status === 'paid',
          expiresAt: status === 'paid' ? '2026-11-23T03:00:00.000Z' : null,
        }).success,
        status,
      ).toBe(true);
    }
    expect(packageOrderFakeResultBodySchema.safeParse({ result: 'paid' }).success).toBe(true);
    expect(packageOrderFakeResultBodySchema.safeParse({ result: 'pending' }).success).toBe(false);
    expect(packageWebhookParamsSchema.safeParse({ gateway: 'mpay' }).success).toBe(true);
    expect(packageWebhookParamsSchema.safeParse({ gateway: 'omise' }).success).toBe(false);
  });

  it('describes the price list and my package (null = unlimited)', () => {
    const card = (code: string, price: number, featured = false) => ({
      code,
      name: code,
      days: 3,
      photoLimit: 100,
      featured,
      free: code === 'free',
      price: packageTotal(price, 700),
    });
    expect(
      packagesResponseSchema.safeParse({
        packages: [card('free', 0), card('d7', 59_900, true)],
        currency: 'THB',
        vatRateBasisPoints: 700,
        sales: { salesEnabled: false, featuredCode: 'd7', onlinePayment: false },
      }).success,
    ).toBe(true);
    expect(myPackageResponseSchema.parse(null)).toBeNull();
    expect(
      myPackageResponseSchema.safeParse({
        code: 'free',
        name: 'Free',
        startsAt: '2026-11-16T03:00:00.000Z',
        expiresAt: '2026-11-19T03:00:00.000Z',
        photoLimit: 100,
        photosUsed: 0,
        expired: false,
      }).success,
    ).toBe(true);
  });

  it('round-trips the order cookie and rejects tampered values', () => {
    const value = packageOrderCookieValue(orderId, token);
    expect(value).toBe(`${orderId}.${token}`);
    expect(parsePackageOrderCookie(value)).toEqual({ orderId, accessToken: token });
    expect(parsePackageOrderCookie(undefined)).toBeNull();
    expect(parsePackageOrderCookie('nodot')).toBeNull();
    expect(parsePackageOrderCookie(`${orderId}.short`)).toBeNull();
    expect(parsePackageOrderCookie(`not-a-uuid.${token}`)).toBeNull();
    expect(() => packageOrderCookieValue('nope', token)).toThrow();
  });
});
