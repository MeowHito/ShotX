import { describe, expect, it } from 'vitest';
import { loadBillingConfig } from './billing';
import {
  loadPackageGatewayConfig,
  loadPackagesConfig,
  loadPackagesWebConfig,
  packagesClientConfigOf,
  packagesClientConfigSchema,
} from './packages';

const mpayEnv = {
  PACKAGE_GATEWAY: 'mpay',
  MPAY_API_URL: 'https://api.mpay.example/v1/',
  MPAY_MERCHANT_ID: 'merchant-123',
  MPAY_SECRET_KEY: 'super-secret-mpay-key-value',
  MPAY_SERVICE_ID: '23173462600000000',
};

describe('loadPackagesConfig (ADR 0026)', () => {
  it('has the ADR defaults: sales off, d7 featured, 7% VAT, sign-up and order limits', () => {
    expect(loadPackagesConfig({})).toEqual({
      salesEnabled: false,
      featuredCode: 'd7',
      vatRateBasisPoints: 700,
      signup: {
        ratePerIp: { limit: 5, windowSeconds: 3_600 },
        emailsPerHour: 3,
        emailsPerDay: 200,
        linkTtlSeconds: 86_400,
      },
      orders: {
        ratePerIp: { limit: 20, windowSeconds: 3_600 },
        setPasswordTtlSeconds: 7 * 86_400,
        inquireAfterSeconds: 30,
        inquireIntervalSeconds: 20,
        payRatePerOrder: { limit: 10, windowSeconds: 600 },
      },
      listCacheMaxAgeSeconds: 60,
    });
  });

  it('reads every key, and shares VAT_RATE_BASIS_POINTS with billing', () => {
    const env = {
      PACKAGE_SALES: 'on',
      PACKAGES_FEATURED_CODE: 'd15',
      VAT_RATE_BASIS_POINTS: '1000',
      SIGNUP_RATE_PER_IP: '10',
      SIGNUP_RATE_PER_IP_WINDOW_SECONDS: '600',
      SIGNUP_EMAILS_PER_HOUR: '2',
      SIGNUP_EMAILS_PER_DAY: '50',
      SIGNUP_LINK_TTL_SECONDS: '3600',
      PACKAGE_ORDER_RATE_PER_IP: '50',
      PACKAGE_ORDER_RATE_PER_IP_WINDOW_SECONDS: '7200',
      PACKAGE_SET_PASSWORD_TTL_SECONDS: '172800',
      PACKAGE_ORDER_INQUIRE_AFTER_SECONDS: '60',
      PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS: '15',
      PACKAGE_PAY_RATE_PER_ORDER: '4',
      PACKAGE_PAY_RATE_PER_ORDER_WINDOW_SECONDS: '300',
      PACKAGES_CACHE_MAX_AGE_SECONDS: '0',
    };
    expect(loadPackagesConfig(env)).toEqual({
      salesEnabled: true,
      featuredCode: 'd15',
      vatRateBasisPoints: 1_000,
      signup: {
        ratePerIp: { limit: 10, windowSeconds: 600 },
        emailsPerHour: 2,
        emailsPerDay: 50,
        linkTtlSeconds: 3_600,
      },
      orders: {
        ratePerIp: { limit: 50, windowSeconds: 7_200 },
        setPasswordTtlSeconds: 172_800,
        inquireAfterSeconds: 60,
        inquireIntervalSeconds: 15,
        payRatePerOrder: { limit: 4, windowSeconds: 300 },
      },
      listCacheMaxAgeSeconds: 0,
    });
    expect(loadBillingConfig(env).vatRateBasisPoints).toBe(1_000);
    expect(loadBillingConfig({}).vatRateBasisPoints).toBe(700);
  });

  it('refuses bad values', () => {
    expect(() => loadPackagesConfig({ PACKAGE_SALES: 'yes' })).toThrow(/PACKAGE_SALES/);
    expect(() => loadPackagesConfig({ PACKAGES_FEATURED_CODE: '7 Days' })).toThrow(
      /PACKAGES_FEATURED_CODE/,
    );
    expect(() => loadPackagesConfig({ SIGNUP_LINK_TTL_SECONDS: '10' })).toThrow(
      /SIGNUP_LINK_TTL_SECONDS/,
    );
    expect(() => loadPackagesConfig({ VAT_RATE_BASIS_POINTS: '10001' })).toThrow(
      /VAT_RATE_BASIS_POINTS/,
    );
  });
});

describe('loadPackageGatewayConfig (ADR 0026 §5)', () => {
  it('is off by default and needs nothing then, even on prod', () => {
    expect(loadPackageGatewayConfig({})).toEqual({ gateway: 'off' });
    expect(loadPackageGatewayConfig({ APP_STAGE: 'prod' })).toEqual({ gateway: 'off' });
  });

  it('allows fake only on the local and test stages', () => {
    for (const stage of ['local', 'test']) {
      expect(loadPackageGatewayConfig({ PACKAGE_GATEWAY: 'fake', APP_STAGE: stage })).toEqual({
        gateway: 'fake',
      });
    }
    for (const stage of ['prod', 'staging', 'production', undefined]) {
      expect(
        () => loadPackageGatewayConfig({ PACKAGE_GATEWAY: 'fake', APP_STAGE: stage }),
        String(stage),
      ).toThrow(/PACKAGE_GATEWAY=fake is allowed only on APP_STAGE=local or test/);
    }
  });

  it('requires the mpay settings only with mpay, and allows mpay on prod', () => {
    expect(loadPackageGatewayConfig({ ...mpayEnv, APP_STAGE: 'prod' })).toEqual({
      gateway: 'mpay',
      mpay: {
        apiUrl: 'https://api.mpay.example/v1',
        merchantId: 'merchant-123',
        secretKey: 'super-secret-mpay-key-value',
        serviceId: '23173462600000000',
        methods: ['qr', 'card'],
        qrExpireSeconds: 600,
        timeoutMs: 15_000,
      },
    });
    for (const key of [
      'MPAY_API_URL',
      'MPAY_MERCHANT_ID',
      'MPAY_SECRET_KEY',
      'MPAY_SERVICE_ID',
    ] as const) {
      expect(() => loadPackageGatewayConfig({ ...mpayEnv, [key]: undefined }), key).toThrow(
        new RegExp(`required with PACKAGE_GATEWAY=mpay[\\s\\S]*${key}`),
      );
    }
    // Not required when the gateway isn't mpay (validated only when set, like other loaders).
    expect(loadPackageGatewayConfig({ PACKAGE_GATEWAY: 'fake', APP_STAGE: 'test' })).toEqual({
      gateway: 'fake',
    });
  });

  it('reads the pay page methods in order, without duplicates, and only known ones', () => {
    const methods = (MPAY_METHODS: string) => {
      const config = loadPackageGatewayConfig({ ...mpayEnv, MPAY_METHODS });
      return config.gateway === 'mpay' ? config.mpay.methods : null;
    };
    expect(methods('card, qr')).toEqual(['card', 'qr']);
    expect(methods('qr,qr')).toEqual(['qr']);
    expect(() => methods('qr,cash')).toThrow(/MPAY_METHODS/);
    expect(() => methods(' , ')).toThrow(/MPAY_METHODS/);
    expect(() => loadPackageGatewayConfig({ ...mpayEnv, MPAY_SERVICE_ID: 'abc' })).toThrow(
      /MPAY_SERVICE_ID/,
    );
  });

  it('wants an https mpay URL and never repeats the secret in errors', () => {
    expect(() =>
      loadPackageGatewayConfig({ ...mpayEnv, MPAY_API_URL: 'http://api.mpay.example' }),
    ).toThrow(/MPAY_API_URL/);
    const error = (() => {
      try {
        loadPackageGatewayConfig({ ...mpayEnv, MPAY_API_URL: 'nope' });
      } catch (e) {
        return String(e);
      }
      return 'did not throw';
    })();
    expect(error).toContain('MPAY_API_URL');
    expect(error).not.toContain(mpayEnv.MPAY_SECRET_KEY);
  });
});

describe('client-safe package settings', () => {
  it('says online payment is available only with sales on and a gateway', () => {
    const on = loadPackagesConfig({ PACKAGE_SALES: 'on' });
    const off = loadPackagesConfig({});
    expect(packagesClientConfigOf(on, { gateway: 'mpay' })).toEqual({
      salesEnabled: true,
      featuredCode: 'd7',
      onlinePayment: true,
    });
    expect(packagesClientConfigOf(on, { gateway: 'off' }).onlinePayment).toBe(false);
    expect(packagesClientConfigOf(off, { gateway: 'fake' })).toEqual({
      salesEnabled: false,
      featuredCode: 'd7',
      onlinePayment: false,
    });
    const view = packagesClientConfigOf(on, loadPackageGatewayConfig(mpayEnv));
    expect(packagesClientConfigSchema.parse(view)).toEqual(view);
    // Nothing secret leaks into the client view.
    expect(JSON.stringify(view)).not.toContain('merchant');
  });

  it('reads the web polling settings', () => {
    expect(loadPackagesWebConfig({})).toEqual({
      orderPoll: { intervalSeconds: 3, timeoutSeconds: 120 },
    });
    expect(
      loadPackagesWebConfig({
        PACKAGE_ORDER_POLL_INTERVAL_SECONDS: '5',
        PACKAGE_ORDER_POLL_TIMEOUT_SECONDS: '300',
      }),
    ).toEqual({ orderPoll: { intervalSeconds: 5, timeoutSeconds: 300 } });
  });
});
