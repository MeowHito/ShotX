import { describe, expect, it } from 'vitest';
import {
  accountEmailSchema,
  normalizeAccountEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_POLICY_REASONS,
  passwordPolicyViolation,
} from '../account/password-accounts';
import {
  loadAdminBffAuthConfig,
  loadAdminPasswordPolicy,
  loadBffAuthConfig,
  loadBffKeysConfig,
  loadPhotographerPasswordPolicy,
  loadShotxAuthConfig,
} from '../config/auth';
import {
  ADMIN_GENERATED_PASSWORD_MIN_LENGTH,
  ADMIN_LIST_PAGE_SIZE_LIMIT,
  loadAdminConsoleConfig,
  loadAdminPasswordUiConfig,
  requiredGeneratedPasswordLength,
} from '../config/admin-console';
import { loadStorageQuotaConfig } from '../config/upload';
import {
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_TARGET_TYPES,
  AUTH_AUDIT_ACTION_PREFIX,
  AUTH_AUDIT_ACTIONS,
} from '../domain';
import { ERROR_CODES, ERROR_DETAILS_SCHEMAS, ERROR_HTTP_STATUS, ErrorCode } from '../errors';
import {
  ADMIN_AUDIT_META_SCHEMAS,
  adminUserSchema,
  CASH_PAYMENT_MAX_SATANG,
  CASH_PAYMENT_PAID_AT_MAX_AHEAD_SECONDS,
  CASH_PAYMENT_NOTE_MAX_LENGTH,
  cashPaymentSchema,
  createAdminUserBodySchema,
  createCashPaymentBodySchema,
  createCashPaymentHeadersSchema,
  decodeAdminUserCursor,
  decodeCashPaymentCursor,
  encodeAdminUserCursor,
  encodeCashPaymentCursor,
  listAdminUsersQuerySchema,
  listCashPaymentsQuerySchema,
  resetAdminUserPasswordBodySchema,
  updateAdminUserBodySchema,
} from './admin';
import {
  ADMIN_SIGN_IN_STEPS,
  adminChangePasswordBodySchema,
  adminChangePasswordResponseSchema,
  adminLoginResponseSchema,
  photographerChangePasswordBodySchema,
  photographerSignInBodySchema,
  photographerSignInResponseSchema,
} from './auth';
import { driveUsageResponseSchema } from './drive';
import {
  ADMIN_ROUTE_ERRORS,
  ADMIN_ROUTES,
  ALL_ROUTES,
  BFF_KEY_SCOPES,
  allowedDuringPasswordChange,
  apiPath,
  AUTH_ROUTES,
  BILLING_ROUTES,
  DRIVE_ROUTES,
  ME_ROUTES,
  PASSWORD_CHANGE_ALLOWED_ROUTES,
  PHOTOGRAPHER_ACCOUNT_ROUTES,
  type RouteContract,
  SHARE_ROUTES,
  SIGNED_IN_ROUTE_ERRORS,
  UPLOAD_ROUTES,
} from './routes';

const token = 'A'.repeat(43);
const id = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const now = '2026-11-10T03:00:00.000Z';
const tokens = {
  accessToken: 'header.payload.signature',
  refreshToken: token,
  expiresIn: 900,
  refreshExpiresIn: 1800,
  user: { email: 'photographer@example.test', name: 'ช่างภาพ' },
};

describe('account domain (ADR 0010)', () => {
  it('roles, statuses and audit actions', () => {
    expect(ACCOUNT_ROLES).toEqual(['admin', 'photographer']);
    expect(ACCOUNT_STATUSES).toEqual(['active', 'disabled']);
    expect(ADMIN_AUDIT_ACTIONS).toEqual([
      'admin.user.created',
      'admin.user.updated',
      'admin.user.disabled',
      'admin.user.enabled',
      'admin.user.password_reset',
      'admin.cash_payment.created',
    ]);
    // Admin actions always have an actor: they must not use the actor-less `auth.` prefix.
    for (const action of ADMIN_AUDIT_ACTIONS) {
      expect(action.startsWith(AUTH_AUDIT_ACTION_PREFIX)).toBe(false);
    }
    for (const action of AUTH_AUDIT_ACTIONS) expect(action.startsWith('auth.')).toBe(true);
    expect(AUTH_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'auth.photographer.sign_in',
        'auth.photographer.sign_in_failed',
        'auth.photographer.locked',
        'auth.photographer.password_changed',
        'auth.admin.password_changed',
      ]),
    );
    expect(ADMIN_AUDIT_TARGET_TYPES).toEqual({ user: 'user', cashPayment: 'cash_payment' });
  });
});

describe('password accounts', () => {
  it('normalizes emails like lower(email COLLATE "C")', () => {
    expect(normalizeAccountEmail('  Ops@Example.COM ')).toBe('ops@example.com');
    // Only ASCII A-Z is folded, as COLLATE "C" does.
    expect(normalizeAccountEmail('ÉLÈVE@example.com')).toBe('ÉlÈve@example.com');
    expect(accountEmailSchema.parse('  a@example.test ')).toBe('a@example.test');
    expect(accountEmailSchema.safeParse('not-an-email').success).toBe(false);
    expect(accountEmailSchema.safeParse(`${'a'.repeat(250)}@x.co`).success).toBe(false);
  });

  it('checks length, simplicity and the email; leaves common and same_as_current to the api', () => {
    const policy = { minLength: 10, email: 'Somchai.P@example.test' };
    expect(passwordPolicyViolation('short', policy)).toBe('too_short');
    // Code points, not UTF-16 units: 9 Thai characters plus one emoji (2 units) is 10.
    expect(passwordPolicyViolation('รหัสผ่านดี😀', { minLength: 10 })).toBeNull();
    expect(passwordPolicyViolation('รหัสผ่าน😀', { minLength: 10 })).toBe('too_short');
    expect(passwordPolicyViolation('aaaaaaaaaaaa', policy)).toBe('too_simple');
    expect(passwordPolicyViolation('abababababab', policy)).toBe('too_simple');
    expect(passwordPolicyViolation('1234567890', policy)).toBe('too_simple');
    expect(passwordPolicyViolation('9876543210', policy)).toBe('too_simple');
    expect(passwordPolicyViolation('xx-SOMCHAI.P-2026', policy)).toBe('contains_email');
    expect(passwordPolicyViolation('correct horse battery', policy)).toBeNull();
    expect(
      passwordPolicyViolation('ab-q7-horse-battery', { minLength: 10, email: 'ab@x.test' }),
    ).toBeNull();
    expect(() => passwordPolicyViolation('x', { minLength: 0 })).toThrow(RangeError);
    expect(PASSWORD_POLICY_REASONS).toEqual([
      'too_short',
      'too_simple',
      'contains_email',
      'common',
      'same_as_current',
    ]);
  });
});

describe('error codes (ADR 0010)', () => {
  it('have statuses, and PASSWORD_TOO_WEAK has details', () => {
    expect(ERROR_HTTP_STATUS).toMatchObject({
      PASSWORD_CHANGE_REQUIRED: 403,
      ACCOUNT_DISABLED: 403,
      EMAIL_TAKEN: 409,
      LAST_ADMIN: 409,
      CANNOT_MODIFY_SELF: 403,
      PASSWORD_TOO_WEAK: 422,
    });
    for (const code of Object.keys(ERROR_HTTP_STATUS)) expect(ERROR_CODES).toContain(code);
    expect(
      ERROR_DETAILS_SCHEMAS.PASSWORD_TOO_WEAK.safeParse({ reason: 'too_short', minLength: 10 })
        .success,
    ).toBe(true);
    expect(
      ERROR_DETAILS_SCHEMAS.PASSWORD_TOO_WEAK.safeParse({ reason: 'weak', minLength: 10 }).success,
    ).toBe(false);
  });
});

describe('admin sign-in steps', () => {
  it('answers login with a step, always naming it', () => {
    expect(ADMIN_SIGN_IN_STEPS).toEqual(['change_password', 'enrol_totp', 'totp']);
    const totp = { step: 'totp', challengeId: token, expiresIn: 300 };
    expect(adminLoginResponseSchema.parse(totp)).toEqual(totp);
    expect(adminLoginResponseSchema.parse({ ...totp, step: 'change_password' }).step).toBe(
      'change_password',
    );
    const enrol = {
      step: 'enrol_totp',
      challengeId: token,
      expiresIn: 300,
      otpauthUri: 'otpauth://totp/ShotX:ops@example.test?secret=JBSWY3DPEHPK3PXP&issuer=ShotX',
    };
    expect(adminLoginResponseSchema.parse(enrol)).toEqual(enrol);
    // The pre-ADR-0010 shape had no step.
    expect(adminLoginResponseSchema.safeParse({ challengeId: token, expiresIn: 300 }).success).toBe(
      false,
    );
    expect(
      adminLoginResponseSchema.safeParse({ ...enrol, otpauthUri: 'https://evil.test' }).success,
    ).toBe(false);
    expect(adminLoginResponseSchema.safeParse({ ...totp, step: 'done' }).success).toBe(false);
  });

  it('changes the password inside the sign-in, then enrols or asks for the code', () => {
    expect(
      adminChangePasswordBodySchema.parse({ challengeId: token, newPassword: ' spaces kept ' }),
    ).toEqual({ challengeId: token, newPassword: ' spaces kept ' });
    expect(
      adminChangePasswordBodySchema.safeParse({
        challengeId: token,
        newPassword: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      adminChangePasswordResponseSchema.safeParse({
        step: 'change_password',
        challengeId: token,
        expiresIn: 300,
      }).success,
    ).toBe(false);
    expect(
      adminChangePasswordResponseSchema.parse({ step: 'totp', challengeId: token, expiresIn: 60 })
        .step,
    ).toBe('totp');
  });
});

describe('photographer sign-in', () => {
  it('takes email and password and answers a normal or a restricted session', () => {
    expect(photographerSignInBodySchema.parse({ email: 'p@example.test', password: 'pw' })).toEqual(
      { email: 'p@example.test', password: 'pw' },
    );
    expect(
      photographerSignInBodySchema.safeParse({ email: 'p@example.test', password: '' }).success,
    ).toBe(false);
    expect(
      photographerSignInBodySchema.safeParse({ email: 'p@example.test', password: 'x', extra: 1 })
        .success,
    ).toBe(false);
    for (const step of ['signed_in', 'change_password'] as const) {
      expect(photographerSignInResponseSchema.parse({ step, ...tokens }).step).toBe(step);
    }
    expect(photographerSignInResponseSchema.safeParse(tokens).success).toBe(false);
  });

  it('changes the password with the current one', () => {
    expect(
      photographerChangePasswordBodySchema.parse({ currentPassword: 'a', newPassword: 'b' }),
    ).toEqual({ currentPassword: 'a', newPassword: 'b' });
    expect(photographerChangePasswordBodySchema.safeParse({ newPassword: 'b' }).success).toBe(
      false,
    );
  });
});

describe('admin users schemas', () => {
  const user = {
    id,
    email: 'p@example.test',
    name: 'ช่างภาพ',
    role: 'photographer',
    status: 'active',
    passwordAccount: true,
    mustChangePassword: true,
    totpEnrolled: null,
    lockedUntil: null,
    createdAt: now,
    createdById: id,
    disabledAt: null,
    lastSignInAt: null,
    usedBytes: 0,
  };

  it('describes an account', () => {
    expect(adminUserSchema.parse(user)).toEqual(user);
    expect(adminUserSchema.parse({ ...user, role: 'admin', usedBytes: null }).usedBytes).toBeNull();
    expect(adminUserSchema.safeParse({ ...user, role: 'user' }).success).toBe(false);
    for (const totpEnrolled of [true, false]) {
      expect(
        adminUserSchema.parse({ ...user, role: 'admin', usedBytes: null, totpEnrolled })
          .totpEnrolled,
      ).toBe(totpEnrolled);
    }
    const { totpEnrolled: _omitted, ...withoutTotp } = user;
    void _omitted;
    expect(adminUserSchema.safeParse(withoutTotp).success).toBe(false);
    expect(adminUserSchema.safeParse({ ...user, status: 'deleted' }).success).toBe(false);
  });

  it('parses the list query from strings', () => {
    expect(
      listAdminUsersQuerySchema.parse({
        q: '  somchai ',
        role: 'admin',
        status: 'disabled',
        limit: '20',
      }),
    ).toEqual({ q: 'somchai', role: 'admin', status: 'disabled', limit: 20 });
    expect(listAdminUsersQuerySchema.parse({})).toEqual({});
    expect(listAdminUsersQuerySchema.safeParse({ role: 'user' }).success).toBe(false);
    expect(listAdminUsersQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(
      listAdminUsersQuerySchema.safeParse({ limit: String(ADMIN_LIST_PAGE_SIZE_LIMIT + 1) })
        .success,
    ).toBe(false);
  });

  it('round-trips cursors with microsecond timestamps and rejects others', () => {
    const cursor = { v: 1 as const, createdAt: '2026-11-10 03:00:00.123456+00', id };
    expect(decodeAdminUserCursor(encodeAdminUserCursor(cursor))).toEqual(cursor);
    expect(decodeAdminUserCursor('not a cursor')).toBeNull();
    const payment = { v: 1 as const, paidAt: '2026-11-10 03:00:00.5+00', id };
    expect(decodeCashPaymentCursor(encodeCashPaymentCursor(payment))).toEqual(payment);
    // A users cursor is not a cash-payments cursor.
    expect(decodeCashPaymentCursor(encodeAdminUserCursor(cursor))).toBeNull();
  });

  it('creates admins and photographers only, with trimmed email and name', () => {
    const body = {
      email: ' P@Example.test ',
      name: ' ช่างภาพ ',
      role: 'photographer',
      password: 'x',
    };
    expect(createAdminUserBodySchema.parse(body)).toEqual({
      email: 'P@Example.test',
      name: 'ช่างภาพ',
      role: 'photographer',
      password: 'x',
    });
    expect(createAdminUserBodySchema.safeParse({ ...body, role: 'user' }).success).toBe(false);
    expect(createAdminUserBodySchema.safeParse({ ...body, password: '' }).success).toBe(false);
    expect(createAdminUserBodySchema.safeParse({ ...body, status: 'active' }).success).toBe(false);
  });

  it('updates name or status, never role; resets with a password', () => {
    expect(updateAdminUserBodySchema.parse({ status: 'disabled' })).toEqual({ status: 'disabled' });
    expect(updateAdminUserBodySchema.parse({ name: ' ใหม่ ' })).toEqual({ name: 'ใหม่' });
    expect(updateAdminUserBodySchema.safeParse({}).success).toBe(false);
    expect(updateAdminUserBodySchema.safeParse({ role: 'admin' }).success).toBe(false);
    expect(resetAdminUserPasswordBodySchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(resetAdminUserPasswordBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('cash payments schemas', () => {
  it('records positive integer satang with an optional trimmed note', () => {
    const body = { photographerId: id, amountSatang: 39_000, paidAt: now };
    expect(createCashPaymentBodySchema.parse(body)).toEqual(body);
    expect(createCashPaymentBodySchema.parse({ ...body, note: '  เงินสด ' })).toEqual({
      ...body,
      note: 'เงินสด',
    });
    expect(createCashPaymentBodySchema.parse({ ...body, note: '   ' }).note).toBeUndefined();
    for (const amountSatang of [0, -1, 1.5, CASH_PAYMENT_MAX_SATANG + 1]) {
      expect(createCashPaymentBodySchema.safeParse({ ...body, amountSatang }).success).toBe(false);
    }
    expect(
      createCashPaymentBodySchema.safeParse({
        ...body,
        note: 'x'.repeat(CASH_PAYMENT_NOTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(createCashPaymentBodySchema.safeParse({ ...body, paidAt: '2026-11-10' }).success).toBe(
      false,
    );
    expect(createCashPaymentHeadersSchema.safeParse({}).success).toBe(false);
    expect(createCashPaymentHeadersSchema.parse({ 'idempotency-key': 'k-1' })).toEqual({
      'idempotency-key': 'k-1',
    });
    const row = { id, ...body, note: null, recordedById: id, createdAt: now };
    expect(cashPaymentSchema.parse(row)).toEqual(row);
    expect(listCashPaymentsQuerySchema.parse({ photographerId: id, limit: '5' })).toEqual({
      photographerId: id,
      limit: 5,
    });
  });
});

describe('account routes', () => {
  it('admin routes are `admin` under /admin with the MFA and disabled errors', () => {
    for (const route of Object.values(ADMIN_ROUTES)) {
      expect(route.auth).toBe('admin');
      expect(route.path.startsWith('/admin/')).toBe(true);
      expect(route.errors).toEqual(expect.arrayContaining([...ADMIN_ROUTE_ERRORS]));
      expect(ALL_ROUTES).toContain(route);
    }
    expect(ADMIN_ROUTES.createUser.errors).toEqual(
      expect.arrayContaining([ErrorCode.EMAIL_TAKEN, ErrorCode.PASSWORD_TOO_WEAK]),
    );
    expect(ADMIN_ROUTES.updateUser.errors).toEqual(
      expect.arrayContaining([ErrorCode.LAST_ADMIN, ErrorCode.CANNOT_MODIFY_SELF]),
    );
    expect(ADMIN_ROUTES.createCashPayment.headers).toBe(createCashPaymentHeadersSchema);
    expect(apiPath(ADMIN_ROUTES.resetPassword, { id })).toBe(
      `/api/admin/users/${id}/reset-password`,
    );
  });

  it('every photographer and user route can answer ACCOUNT_DISABLED and PASSWORD_CHANGE_REQUIRED', () => {
    for (const route of ALL_ROUTES) {
      if (route.auth !== 'photographer' && route.auth !== 'user') continue;
      expect(route.errors, route.path).toContain(ErrorCode.ACCOUNT_DISABLED);
      if (allowedDuringPasswordChange(route)) {
        expect(route.errors, route.path).not.toContain(ErrorCode.PASSWORD_CHANGE_REQUIRED);
      } else {
        expect(route.errors, route.path).toEqual(
          expect.arrayContaining([...SIGNED_IN_ROUTE_ERRORS]),
        );
      }
    }
    expect(DRIVE_ROUTES.listChildren.errors).toContain(ErrorCode.PASSWORD_CHANGE_REQUIRED);
    expect(UPLOAD_ROUTES.init.errors).toContain(ErrorCode.PASSWORD_CHANGE_REQUIRED);
    expect(SHARE_ROUTES.create.errors).toContain(ErrorCode.PASSWORD_CHANGE_REQUIRED);
  });

  it('a restricted session may only read /me and change its password', () => {
    expect(PASSWORD_CHANGE_ALLOWED_ROUTES).toEqual([
      ME_ROUTES.get,
      PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword,
    ]);
    expect(allowedDuringPasswordChange({ method: 'GET', path: '/me' })).toBe(true);
    expect(
      allowedDuringPasswordChange({ method: 'POST', path: '/auth/photographer/password' }),
    ).toBe(true);
    expect(allowedDuringPasswordChange(DRIVE_ROUTES.listChildren)).toBe(false);
    expect(allowedDuringPasswordChange({ method: 'POST', path: '/me' })).toBe(false);
  });

  it('photographer sign-in is bff; the password change needs the token and stays server-side', () => {
    expect(AUTH_ROUTES.photographerSignIn).toMatchObject({
      method: 'POST',
      path: '/auth/photographer/sign-in',
      auth: 'bff',
    });
    expect(AUTH_ROUTES.photographerSignIn.errors).toEqual(
      expect.arrayContaining([ErrorCode.INVALID_CREDENTIALS, ErrorCode.ACCOUNT_DISABLED]),
    );
    expect(AUTH_ROUTES.adminChangePassword).toMatchObject({
      path: '/auth/admin/password',
      auth: 'bff',
    });
    const change = PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword;
    expect(change).toMatchObject({ auth: 'photographer', serverOnly: true, status: 200 });
    expect(change.errors).toEqual(
      expect.arrayContaining([ErrorCode.PASSWORD_INCORRECT, ErrorCode.PASSWORD_TOO_WEAK]),
    );
    // Only routes whose responses carry tokens are server-only.
    const serverOnly = ALL_ROUTES.filter((r) => r.serverOnly === true);
    expect(serverOnly).toEqual([change]);
  });

  it('billing routes can be NOT_FOUND (BILLING_MODE=offline); self-serve onboarding is deprecated', () => {
    for (const route of Object.values(BILLING_ROUTES)) {
      expect(route.errors, route.path).toContain(ErrorCode.NOT_FOUND);
    }
    expect(ME_ROUTES.becomePhotographer.errors).toContain(ErrorCode.FORBIDDEN);
  });
});

describe('account config', () => {
  it('reads the photographer sign-in keys with defaults, mirroring the admin ones', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const key = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const env = { AUTH_PROVIDER: 'local', APP_STAGE: 'local', AUTH_USERS_SIGNING_KEY: key };
    expect(loadShotxAuthConfig(env).photographer).toEqual({
      passwordMinLength: 10,
      rateLimits: {
        perAccount: { limit: 5, windowSeconds: 900 },
        perIp: { limit: 20, windowSeconds: 900 },
      },
      lockout: { threshold: 10, seconds: 900 },
      passwordChangeSessionTtlSeconds: 1800,
    });
    expect(
      loadShotxAuthConfig({ ...env, PHOTOGRAPHER_PASSWORD_MIN_LENGTH: '8' }).photographer
        .passwordMinLength,
    ).toBe(8);
    for (const bad of ['7', '129']) {
      expect(() => loadShotxAuthConfig({ ...env, PHOTOGRAPHER_PASSWORD_MIN_LENGTH: bad })).toThrow(
        /PHOTOGRAPHER_PASSWORD_MIN_LENGTH/,
      );
    }
    expect(() =>
      loadShotxAuthConfig({
        ...env,
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '3600',
        PHOTOGRAPHER_PASSWORD_CHANGE_SESSION_TTL_SECONDS: '600',
      }),
    ).toThrow(/at least AUTH_ACCESS_TOKEN_TTL_SECONDS/);
    // ADMIN_PASSWORD_MIN_LENGTH is unchanged.
    expect(() => loadShotxAuthConfig({ ...env, ADMIN_PASSWORD_MIN_LENGTH: '10' })).toThrow(
      /ADMIN_PASSWORD_MIN_LENGTH/,
    );
  });

  it('reads the password policies without any secret, the same values loadShotxAuthConfig uses', async () => {
    expect(loadPhotographerPasswordPolicy({})).toEqual({ minLength: 10 });
    expect(loadPhotographerPasswordPolicy({ PHOTOGRAPHER_PASSWORD_MIN_LENGTH: '12' })).toEqual({
      minLength: 12,
    });
    for (const bad of ['7', '129', 'ten']) {
      expect(() =>
        loadPhotographerPasswordPolicy({ PHOTOGRAPHER_PASSWORD_MIN_LENGTH: bad }),
      ).toThrow(/PHOTOGRAPHER_PASSWORD_MIN_LENGTH/);
    }
    // Ignores the other pool's key.
    expect(loadPhotographerPasswordPolicy({ ADMIN_PASSWORD_MIN_LENGTH: '1' })).toEqual({
      minLength: 10,
    });
    expect(loadAdminPasswordPolicy({})).toEqual({ minLength: 14 });
    expect(() => loadAdminPasswordPolicy({ ADMIN_PASSWORD_MIN_LENGTH: '11' })).toThrow(
      /ADMIN_PASSWORD_MIN_LENGTH/,
    );
    const { generateKeyPairSync } = await import('node:crypto');
    const key = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const env = {
      AUTH_PROVIDER: 'local',
      APP_STAGE: 'local',
      AUTH_USERS_SIGNING_KEY: key,
      PHOTOGRAPHER_PASSWORD_MIN_LENGTH: '16',
    };
    expect(loadShotxAuthConfig(env).photographer.passwordMinLength).toBe(
      loadPhotographerPasswordPolicy(env).minLength,
    );
  });

  it('turns the storage quota off by default', () => {
    expect(loadStorageQuotaConfig({})).toEqual({ enforced: false });
    expect(loadStorageQuotaConfig({ STORAGE_QUOTA_ENFORCED: 'true' })).toEqual({ enforced: true });
    expect(loadStorageQuotaConfig({ STORAGE_QUOTA_ENFORCED: '0' })).toEqual({ enforced: false });
    expect(() => loadStorageQuotaConfig({ STORAGE_QUOTA_ENFORCED: 'maybe' })).toThrow(
      /STORAGE_QUOTA_ENFORCED/,
    );
  });

  it('reads the admin list page size', () => {
    expect(loadAdminConsoleConfig({})).toEqual({ listPageSize: 50 });
    expect(loadAdminConsoleConfig({ ADMIN_LIST_PAGE_SIZE: '100' })).toEqual({ listPageSize: 100 });
    expect(() => loadAdminConsoleConfig({ ADMIN_LIST_PAGE_SIZE: '201' })).toThrow(
      /ADMIN_LIST_PAGE_SIZE/,
    );
  });

  it('reports no quota in the usage response while it is not enforced', () => {
    const usage = {
      usedBytes: 10,
      reservedBytes: 0,
      quotaBytes: null,
      availableBytes: null,
      trashBytes: 0,
      subscription: null,
      uploadsBlockedBy: null,
    };
    expect(driveUsageResponseSchema.parse(usage)).toEqual(usage);
    expect(
      driveUsageResponseSchema.parse({ ...usage, quotaBytes: 100, availableBytes: 90 }),
    ).toMatchObject({ quotaBytes: 100 });
  });
});

describe('contract change requests (wave 9)', () => {
  it('OIDC callback and dev login can answer ACCOUNT_DISABLED', () => {
    expect(AUTH_ROUTES.oidcCallback.errors).toContain(ErrorCode.ACCOUNT_DISABLED);
    expect(AUTH_ROUTES.devLogin.errors).toContain(ErrorCode.ACCOUNT_DISABLED);
  });

  it('types the admin audit metas the api writes', () => {
    const m = ADMIN_AUDIT_META_SCHEMAS;
    expect(Object.keys(m)).toEqual([...ADMIN_AUDIT_ACTIONS]);
    expect(
      m['admin.user.updated'].safeParse({ changed: ['name'], oldName: null, newName: 'ใหม่' })
        .success,
    ).toBe(true);
    expect(m['admin.user.updated'].safeParse({ changed: ['name'] }).success).toBe(false);
    expect(m['admin.user.updated'].safeParse({ changed: [] }).success).toBe(false);
    expect(m['admin.user.updated'].safeParse({ changed: ['status'] }).success).toBe(true);
    expect(m['admin.user.password_reset'].safeParse({}).success).toBe(true);
    expect(m['admin.user.disabled'].safeParse({ revokedSessions: 2 }).success).toBe(true);
    expect(
      m['admin.user.created'].safeParse({ role: 'photographer', email: 'p@example.test' }).success,
    ).toBe(true);
    expect(
      m['admin.cash_payment.created'].safeParse({
        photographerId: id,
        amountSatang: 39_000,
        paidAt: now,
      }).success,
    ).toBe(true);
  });
});

describe('review fixes (wave 9)', () => {
  it('reads the generated password length, never below either pool minimum', () => {
    expect(loadAdminPasswordUiConfig({})).toEqual({
      generatedLength: 20,
      minLength: { admin: 14, photographer: 10 },
    });
    expect(
      loadAdminPasswordUiConfig({ ADMIN_GENERATED_PASSWORD_LENGTH: '16' }).generatedLength,
    ).toBe(16);
    for (const bad of ['15', '129']) {
      expect(() => loadAdminPasswordUiConfig({ ADMIN_GENERATED_PASSWORD_LENGTH: bad })).toThrow(
        /ADMIN_GENERATED_PASSWORD_LENGTH/,
      );
    }
    expect(() =>
      loadAdminPasswordUiConfig({
        ADMIN_GENERATED_PASSWORD_LENGTH: '20',
        ADMIN_PASSWORD_MIN_LENGTH: '24',
      }),
    ).toThrow(/at least 24/);
    expect(requiredGeneratedPasswordLength({ admin: 14, photographer: 10 })).toBe(16);
    expect(requiredGeneratedPasswordLength({ admin: 14, photographer: 30 })).toBe(30);
    expect(ADMIN_GENERATED_PASSWORD_MIN_LENGTH).toBe(16);
  });

  it('exports the paid_at tolerance of cash_payments_paid_at_not_future', () => {
    expect(CASH_PAYMENT_PAID_AT_MAX_AHEAD_SECONDS).toBe(86_400);
  });

  it('no longer advertises a success response for POST /me/photographer', () => {
    const route = ME_ROUTES.becomePhotographer as RouteContract;
    expect(route.status).toBe(204);
    expect(route.response).toBeUndefined();
    expect(route.body).toBeUndefined();
  });
});

describe('separate admin BFF key (wave 9 round 2)', () => {
  const web = 'w'.repeat(40);
  const admin = 'a'.repeat(40);

  it('web reads only AUTH_BFF_KEY, the admin app only AUTH_ADMIN_BFF_KEY', () => {
    const env = { AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: web, AUTH_ADMIN_BFF_KEY: admin };
    expect(loadBffAuthConfig(env)).toEqual({ key: web });
    expect(loadAdminBffAuthConfig(env)).toEqual({ key: admin });
    // Each loader works without the other app's key.
    expect(loadBffAuthConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: web })).toEqual({ key: web });
    expect(loadAdminBffAuthConfig({ AUTH_PROVIDER: 'shotx', AUTH_ADMIN_BFF_KEY: admin })).toEqual({
      key: admin,
    });
  });

  it('requires the admin key with shotx and local, at least 32 characters, never the placeholder off local', () => {
    expect(() => loadAdminBffAuthConfig({ AUTH_PROVIDER: 'shotx' })).toThrow(
      /AUTH_ADMIN_BFF_KEY is required/,
    );
    expect(() =>
      loadAdminBffAuthConfig({ AUTH_PROVIDER: 'shotx', AUTH_ADMIN_BFF_KEY: 'short' }),
    ).toThrow(/AUTH_ADMIN_BFF_KEY/);
    expect(loadAdminBffAuthConfig({ APP_STAGE: 'prod' })).toBeNull();
    const placeholder = 'local-dev-only-admin-bff-key-change-me-0123456789';
    expect(() =>
      loadAdminBffAuthConfig({
        AUTH_PROVIDER: 'shotx',
        APP_STAGE: 'prod',
        AUTH_ADMIN_BFF_KEY: placeholder,
      }),
    ).toThrow(/AUTH_ADMIN_BFF_KEY is the published .env.example placeholder/);
    expect(
      loadAdminBffAuthConfig({
        AUTH_PROVIDER: 'local',
        APP_STAGE: 'local',
        AUTH_ADMIN_BFF_KEY: placeholder,
      }),
    ).toEqual({ key: placeholder });
    try {
      loadAdminBffAuthConfig({
        AUTH_PROVIDER: 'shotx',
        APP_STAGE: 'prod',
        AUTH_ADMIN_BFF_KEY: placeholder,
      });
    } catch (error) {
      expect(String(error)).not.toContain(placeholder);
    }
  });

  it('the api reads both and refuses one key for both apps', () => {
    expect(
      loadBffKeysConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: web, AUTH_ADMIN_BFF_KEY: admin }),
    ).toEqual({ users: { key: web }, admins: { key: admin } });
    expect(() =>
      loadBffKeysConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: web, AUTH_ADMIN_BFF_KEY: web }),
    ).toThrow(/AUTH_ADMIN_BFF_KEY must be different from AUTH_BFF_KEY/);
    expect(() => loadBffKeysConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: web })).toThrow(
      /AUTH_ADMIN_BFF_KEY is required/,
    );
    expect(loadBffKeysConfig({})).toEqual({ users: null, admins: null });
  });

  it('every bff and admin route names the key it accepts', () => {
    expect(BFF_KEY_SCOPES).toEqual(['users', 'admins', 'request', 'either']);
    for (const route of ALL_ROUTES) {
      const needsKey = route.auth === 'bff' || route.auth === 'admin';
      expect(route.bffKey !== undefined, `${route.method} ${route.path}`).toBe(needsKey);
      if (route.auth === 'admin') expect(route.bffKey).toBe('admins');
    }
    expect(
      Object.fromEntries(Object.entries(AUTH_ROUTES).map(([name, r]) => [name, r.bffKey])),
    ).toEqual({
      providers: 'either',
      oidcStart: 'users',
      oidcCallback: 'users',
      devLogin: 'users',
      refresh: 'request',
      logout: 'request',
      adminLogin: 'admins',
      adminChangePassword: 'admins',
      adminMfa: 'admins',
      photographerSignIn: 'users',
    });
  });
});
