import { z } from 'zod';
import type { RateLimitRule } from './face';
import {
  PACKAGE_GATEWAY_MODES,
  PACKAGE_PAYMENT_METHODS,
  type PackageGatewayMode,
  type PackagePaymentMethod,
} from '../domain';
import { LOCAL_DEV_APP_STAGE } from './stage-gate';
import { type Env, parseEnv } from './env';
import {
  httpUrl,
  int,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  secret,
  vatRateBasisPoints,
} from './fields';

// Packages, self sign-up and online payment (ADR 0026). Prices, days and photo limits live in the
// `packages` table (seeded by migration 0016), never here.

/** PACKAGE_SALES values: the kill switch of Free sign-up and package orders. */
export const PACKAGE_SALES_MODES = ['on', 'off'] as const;
export type PackageSalesMode = (typeof PACKAGE_SALES_MODES)[number];

/** A `packages.code` (same format as `packages_code_format`). */
export const PACKAGE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

const requests = int(1, 1_000_000);
const windowSeconds = int(1, SECONDS_PER_DAY);

const packagesEnvSchema = z.object({
  /**
   * `off` (default): `/signup/*` and `/package-orders*` answer NOT_FOUND; the home page still shows
   * the packages and the dialog says to contact the team. `on`: Free sign-up works, and paid
   * orders work when PACKAGE_GATEWAY is not `off`.
   */
  PACKAGE_SALES: z.enum(PACKAGE_SALES_MODES).default('off'),
  /** The highlighted card on the home page. Default `d7`. */
  PACKAGES_FEATURED_CODE: z
    .string()
    .regex(PACKAGE_CODE_PATTERN, { error: 'must be a package code' })
    .default('d7'),
  /** VAT added on top of the VAT-exclusive package prices (vatOnTop). Same key as billing. */
  VAT_RATE_BASIS_POINTS: vatRateBasisPoints(),
  /** POST /signup/free per client IP and window (default 5 per hour). */
  SIGNUP_RATE_PER_IP: requests.default(5),
  SIGNUP_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(SECONDS_PER_HOUR),
  /**
   * Sign-up emails per email address per hour (default 3); more requests are answered 204 the
   * same way and send nothing.
   */
  SIGNUP_EMAILS_PER_HOUR: int(1, 100).default(3),
  /**
   * Sign-up emails (confirmation links and "you already have an account") sent per day in total,
   * all addresses together (default 200): a cap on what an abuser can make Snap send. More
   * requests are answered 204 the same way and send nothing.
   */
  SIGNUP_EMAILS_PER_DAY: int(1, 1_000_000).default(200),
  /** How long the emailed Free confirmation link works (default 24 hours). */
  SIGNUP_LINK_TTL_SECONDS: int(5 * SECONDS_PER_MINUTE, 7 * SECONDS_PER_DAY).default(
    SECONDS_PER_DAY,
  ),
  /** POST /package-orders per client IP and window (default 20 per hour). */
  PACKAGE_ORDER_RATE_PER_IP: requests.default(20),
  PACKAGE_ORDER_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(SECONDS_PER_HOUR),
  /**
   * How long the "ตั้งรหัสผ่าน" link of an account created by a paid order works (an ADR 0025 reset
   * token with this TTL instead of PHOTOGRAPHER_PASSWORD_RESET_TTL_SECONDS). Default 7 days.
   */
  PACKAGE_SET_PASSWORD_TTL_SECONDS: int(SECONDS_PER_HOUR, 30 * SECONDS_PER_DAY).default(
    7 * SECONDS_PER_DAY,
  ),
  /**
   * GET /package-orders/:id asks the gateway (`inquire`, when the adapter has it) once an order has
   * been pending this long. Default 30 seconds.
   */
  PACKAGE_ORDER_INQUIRE_AFTER_SECONDS: int(5, SECONDS_PER_HOUR).default(30),
  /** ... and then at most once per order this often, however often the page polls (default 20). */
  PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS: int(1, SECONDS_PER_HOUR).default(20),
  /**
   * POST /package-orders/:id/pay (ADR 0029: a new QR or card form) per order and window (default
   * 10 per 10 minutes).
   */
  PACKAGE_PAY_RATE_PER_ORDER: int(1, 1000).default(10),
  PACKAGE_PAY_RATE_PER_ORDER_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
  /**
   * ADR 0030: how long a pending (or failed) order holds one of its coupon's uses (default 30
   * minutes). A paid order always counts.
   */
  PACKAGE_COUPON_HOLD_SECONDS: int(SECONDS_PER_MINUTE, 7 * SECONDS_PER_DAY).default(
    30 * SECONDS_PER_MINUTE,
  ),
  /** POST /package-coupons/check per client IP and window (default 30 per 10 minutes). */
  PACKAGE_COUPON_CHECK_RATE_PER_IP: requests.default(30),
  PACKAGE_COUPON_CHECK_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
  /** `Cache-Control: public, max-age` of GET /packages (default 60 seconds). */
  PACKAGES_CACHE_MAX_AGE_SECONDS: int(0, SECONDS_PER_DAY).default(SECONDS_PER_MINUTE),
});

export interface PackagesConfig {
  /** PACKAGE_SALES=on. */
  salesEnabled: boolean;
  featuredCode: string;
  vatRateBasisPoints: number;
  signup: {
    ratePerIp: RateLimitRule;
    emailsPerHour: number;
    emailsPerDay: number;
    linkTtlSeconds: number;
  };
  orders: {
    ratePerIp: RateLimitRule;
    setPasswordTtlSeconds: number;
    inquireAfterSeconds: number;
    inquireIntervalSeconds: number;
    /** POST /package-orders/:id/pay per order (PACKAGE_PAY_RATE_PER_ORDER*). */
    payRatePerOrder: RateLimitRule;
  };
  /** ADR 0030. */
  coupons: {
    /** PACKAGE_COUPON_HOLD_SECONDS. */
    holdSeconds: number;
    /** POST /package-coupons/check per IP (PACKAGE_COUPON_CHECK_RATE_PER_IP*). */
    checkRatePerIp: RateLimitRule;
  };
  /** GET /packages Cache-Control max-age, seconds. */
  listCacheMaxAgeSeconds: number;
}

/**
 * Reads the package settings above (api only; every key has a default): PACKAGE_SALES (`off`),
 * PACKAGES_FEATURED_CODE (`d7`), VAT_RATE_BASIS_POINTS (700), SIGNUP_RATE_PER_IP (5) per
 * SIGNUP_RATE_PER_IP_WINDOW_SECONDS (3600), SIGNUP_EMAILS_PER_HOUR (3), SIGNUP_EMAILS_PER_DAY
 * (200), SIGNUP_LINK_TTL_SECONDS (86400), PACKAGE_ORDER_RATE_PER_IP (20) per
 * PACKAGE_ORDER_RATE_PER_IP_WINDOW_SECONDS (3600), PACKAGE_SET_PASSWORD_TTL_SECONDS (604800),
 * PACKAGE_ORDER_INQUIRE_AFTER_SECONDS (30), PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS (20),
 * PACKAGE_COUPON_HOLD_SECONDS (1800), PACKAGE_COUPON_CHECK_RATE_PER_IP (30) per
 * PACKAGE_COUPON_CHECK_RATE_PER_IP_WINDOW_SECONDS (600) and PACKAGES_CACHE_MAX_AGE_SECONDS (60).
 */
export function loadPackagesConfig(env: Env): PackagesConfig {
  const e = parseEnv(packagesEnvSchema, env, 'packages');
  return {
    salesEnabled: e.PACKAGE_SALES === 'on',
    featuredCode: e.PACKAGES_FEATURED_CODE,
    vatRateBasisPoints: e.VAT_RATE_BASIS_POINTS,
    signup: {
      ratePerIp: {
        limit: e.SIGNUP_RATE_PER_IP,
        windowSeconds: e.SIGNUP_RATE_PER_IP_WINDOW_SECONDS,
      },
      emailsPerHour: e.SIGNUP_EMAILS_PER_HOUR,
      emailsPerDay: e.SIGNUP_EMAILS_PER_DAY,
      linkTtlSeconds: e.SIGNUP_LINK_TTL_SECONDS,
    },
    orders: {
      ratePerIp: {
        limit: e.PACKAGE_ORDER_RATE_PER_IP,
        windowSeconds: e.PACKAGE_ORDER_RATE_PER_IP_WINDOW_SECONDS,
      },
      setPasswordTtlSeconds: e.PACKAGE_SET_PASSWORD_TTL_SECONDS,
      inquireAfterSeconds: e.PACKAGE_ORDER_INQUIRE_AFTER_SECONDS,
      inquireIntervalSeconds: e.PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS,
      payRatePerOrder: {
        limit: e.PACKAGE_PAY_RATE_PER_ORDER,
        windowSeconds: e.PACKAGE_PAY_RATE_PER_ORDER_WINDOW_SECONDS,
      },
    },
    coupons: {
      holdSeconds: e.PACKAGE_COUPON_HOLD_SECONDS,
      checkRatePerIp: {
        limit: e.PACKAGE_COUPON_CHECK_RATE_PER_IP,
        windowSeconds: e.PACKAGE_COUPON_CHECK_RATE_PER_IP_WINDOW_SECONDS,
      },
    },
    listCacheMaxAgeSeconds: e.PACKAGES_CACHE_MAX_AGE_SECONDS,
  };
}

// --- Package payment gateway (api only) -----------------------------------------------------------

/** Secret environment variables of each package gateway. Never logged. */
export const PACKAGE_GATEWAY_SECRET_ENV = {
  fake: [],
  mpay: ['MPAY_SECRET_KEY'],
} as const satisfies Record<Exclude<PackageGatewayMode, 'off'>, readonly string[]>;

const packageGatewayEnvSchema = z
  .object({
    APP_STAGE: z.string().optional(),
    /** `off` (default), `fake` (only on FAKE_PACKAGE_GATEWAY_STAGES) or `mpay`. */
    PACKAGE_GATEWAY: z.enum(PACKAGE_GATEWAY_MODES).default('off'),
    /** mpay API base URL (https). Required with PACKAGE_GATEWAY=mpay. */
    MPAY_API_URL: httpUrl({ path: true, httpsOnly: true }).optional(),
    /** mpay merchant id. Required with PACKAGE_GATEWAY=mpay. */
    MPAY_MERCHANT_ID: z.string().trim().min(1).max(128).optional(),
    /** mpay secret key. Required with PACKAGE_GATEWAY=mpay. Secret: never logged. */
    MPAY_SECRET_KEY: secret().optional(),
    /** mPAY's `service_id` of Snap's service (digits). Required with PACKAGE_GATEWAY=mpay. */
    MPAY_SERVICE_ID: z
      .string()
      .trim()
      .regex(/^[0-9]{1,36}$/, { error: 'must be mPAY digits' })
      .optional(),
    /**
     * The pay page's methods, comma separated, in this order (ADR 0029): `qr` (PromptPay) and/or
     * `card`. Default `qr,card`; list only what mPAY has switched on for the service.
     */
    MPAY_METHODS: z
      .string()
      .default('qr,card')
      .transform((v) => [...new Set(v.split(',').map((m) => m.trim()))])
      .pipe(z.array(z.enum(PACKAGE_PAYMENT_METHODS)).min(1)),
    /** How long one PromptPay QR can be paid (default 10 minutes). */
    MPAY_QR_EXPIRE_SECONDS: int(60, 3600).default(600),
    /** One call to mPAY may take this long (default 15 s). */
    MPAY_TIMEOUT_MS: int(1000, 60_000).default(15_000),
  })
  .superRefine((e, ctx) => {
    if (e.PACKAGE_GATEWAY !== 'mpay') return;
    for (const key of [
      'MPAY_API_URL',
      'MPAY_MERCHANT_ID',
      'MPAY_SECRET_KEY',
      'MPAY_SERVICE_ID',
    ] as const) {
      if (e[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required with PACKAGE_GATEWAY=mpay',
        });
      }
    }
  });

export interface MpayGatewaySettings {
  apiUrl: string;
  merchantId: string;
  /** Secret: never log this object. */
  secretKey: string;
  /** MPAY_SERVICE_ID. */
  serviceId: string;
  /** MPAY_METHODS, in the pay page's order. */
  methods: readonly PackagePaymentMethod[];
  qrExpireSeconds: number;
  timeoutMs: number;
}

/**
 * The APP_STAGE values the fake package gateway may run on (an allowlist, so a new stage such as
 * `staging` or a second production never takes payments that aren't real): local development and
 * tests.
 */
export const FAKE_PACKAGE_GATEWAY_STAGES: readonly string[] = [LOCAL_DEV_APP_STAGE, 'test'];

/** Narrow on `gateway`: `mpay` carries its settings; `off` means no adapter at all. */
export type PackageGatewayConfig =
  { gateway: 'off' } | { gateway: 'fake' } | { gateway: 'mpay'; mpay: MpayGatewaySettings };

/**
 * Reads PACKAGE_GATEWAY (default `off`) and, for `mpay`, MPAY_API_URL, MPAY_MERCHANT_ID,
 * MPAY_SECRET_KEY and MPAY_SERVICE_ID (each required then; optional otherwise, but validated when
 * set) plus MPAY_METHODS, MPAY_QR_EXPIRE_SECONDS and MPAY_TIMEOUT_MS. Throws for
 * `fake` unless APP_STAGE is in FAKE_PACKAGE_GATEWAY_STAGES (NODE_ENV doesn't matter). api only.
 * Error messages never repeat values.
 */
export function loadPackageGatewayConfig(env: Env): PackageGatewayConfig {
  const e = parseEnv(packageGatewayEnvSchema, env, 'package gateway');
  if (
    e.PACKAGE_GATEWAY === 'fake' &&
    (e.APP_STAGE === undefined || !FAKE_PACKAGE_GATEWAY_STAGES.includes(e.APP_STAGE))
  ) {
    throw new Error(
      `Invalid package gateway configuration: PACKAGE_GATEWAY=fake is allowed only on APP_STAGE=${FAKE_PACKAGE_GATEWAY_STAGES.join(' or ')}`,
    );
  }
  switch (e.PACKAGE_GATEWAY) {
    case 'off':
      return { gateway: 'off' };
    case 'fake':
      return { gateway: 'fake' };
    case 'mpay': {
      const {
        MPAY_API_URL: apiUrl,
        MPAY_MERCHANT_ID: merchantId,
        MPAY_SECRET_KEY: secretKey,
        MPAY_SERVICE_ID: serviceId,
      } = e;
      if (
        apiUrl === undefined ||
        merchantId === undefined ||
        secretKey === undefined ||
        serviceId === undefined
      ) {
        // Unreachable: the schema requires them with `mpay`.
        throw new Error('Invalid package gateway configuration: mpay settings are missing');
      }
      return {
        gateway: 'mpay',
        mpay: {
          apiUrl,
          merchantId,
          secretKey,
          serviceId,
          methods: e.MPAY_METHODS,
          qrExpireSeconds: e.MPAY_QR_EXPIRE_SECONDS,
          timeoutMs: e.MPAY_TIMEOUT_MS,
        },
      };
    }
  }
}

// --- Client-safe package settings (web) -----------------------------------------------------------

/**
 * What web may know about package sales: nothing secret. The api builds it with
 * packagesClientConfigOf and sends it in GET /packages (`sales`), so web needs neither
 * PACKAGE_SALES nor PACKAGE_GATEWAY (api only, ADR 0026 §5) in its own environment.
 */
export const packagesClientConfigSchema = z.object({
  /** PACKAGE_SALES=on: Free sign-up and orders are open. */
  salesEnabled: z.boolean(),
  /** PACKAGES_FEATURED_CODE. */
  featuredCode: z.string().regex(PACKAGE_CODE_PATTERN),
  /**
   * Paid packages can be bought online now: sales on and PACKAGE_GATEWAY not `off`. When false
   * the paid cards open the "เปิดชำระเงินออนไลน์เร็ว ๆ นี้ / ติดต่อทีมงาน" dialog.
   */
  onlinePayment: z.boolean(),
});
export type PackagesClientConfig = z.output<typeof packagesClientConfigSchema>;

/** The client-safe view of the api's package settings (GET /packages `sales`). */
export function packagesClientConfigOf(
  packages: Pick<PackagesConfig, 'salesEnabled' | 'featuredCode'>,
  gateway: Pick<PackageGatewayConfig, 'gateway'>,
): PackagesClientConfig {
  return {
    salesEnabled: packages.salesEnabled,
    featuredCode: packages.featuredCode,
    onlinePayment: packages.salesEnabled && gateway.gateway !== 'off',
  };
}

const packagesWebEnvSchema = z.object({
  /** /checkout/return polls GET /package-orders/:id this often (default 3 s). */
  PACKAGE_ORDER_POLL_INTERVAL_SECONDS: int(1, 60).default(3),
  /** ... and gives up after this long, then says to check the email or contact us (2 min). */
  PACKAGE_ORDER_POLL_TIMEOUT_SECONDS: int(10, 30 * SECONDS_PER_MINUTE).default(
    2 * SECONDS_PER_MINUTE,
  ),
});

export interface PackagesWebConfig {
  orderPoll: { intervalSeconds: number; timeoutSeconds: number };
}

/**
 * web only: PACKAGE_ORDER_POLL_INTERVAL_SECONDS (3) and PACKAGE_ORDER_POLL_TIMEOUT_SECONDS (120).
 * Sales, the featured code and online payment come from GET /packages (packagesClientConfigSchema).
 */
export function loadPackagesWebConfig(env: Env): PackagesWebConfig {
  const e = parseEnv(packagesWebEnvSchema, env, 'packages web');
  return {
    orderPoll: {
      intervalSeconds: e.PACKAGE_ORDER_POLL_INTERVAL_SECONDS,
      timeoutSeconds: e.PACKAGE_ORDER_POLL_TIMEOUT_SECONDS,
    },
  };
}
