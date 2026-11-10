import { z } from 'zod';
import { AUTH_POOLS, type AuthPool, type BillingMode, type UserRole } from '../domain';
import { AUTH_SUBJECT_MAX_LENGTH, isAuthSubjectInPool } from './auth-subject';

/**
 * User provisioning (ADR 0002, ADR 0008). Identity is the pair (pool, subject) of a verified token
 * (Cognito, or ShotX-issued: see account/auth-subject); email is never an identity and never
 * merges accounts. On the first authenticated request the API's guard provisions the `users` row
 * in one statement:
 *
 *   INSERT INTO users (auth_pool, auth_subject, role, email, name)
 *   VALUES ($pool, $subject, $role, $email, $name)
 *   ON CONFLICT (auth_pool, auth_subject) DO NOTHING;
 *   SELECT ... FROM users WHERE auth_pool = $pool AND auth_subject = $subject;
 *
 * with the values from {@link newUserForIdentity}. Later sign-ins never change the role, and
 * email and name are only filled on insert. A users-pool identity starts as `user` (viewer); an
 * admins-pool identity is always `admin` (the `users_admin_iff_admins_pool` CHECK enforces both).
 * Since ADR 0010 nobody becomes a photographer through provisioning or `POST /me/photographer`
 * (deprecated, FORBIDDEN): `admin` and `photographer` accounts (`admin:` and `password:`
 * subjects) are created by an admin (POST /admin/users) or the operator CLI, never by the guard.
 */
export const authIdentitySchema = z
  .object({
    pool: z.enum(AUTH_POOLS),
    /**
     * `users.auth_subject`: a raw Cognito `sub`, or a prefixed ShotX subject (`line:...`,
     * `google:...`, `local:...`, `admin:...`). Opaque otherwise.
     */
    sub: z.string().min(1).max(AUTH_SUBJECT_MAX_LENGTH),
    /** From the verified ID token or userinfo; LINE may have none. */
    email: z.email().max(320).nullable(),
    name: z.string().trim().min(1).max(200).nullable(),
  })
  .refine((identity) => isAuthSubjectInPool(identity.sub, identity.pool), {
    error: 'subject is not valid in this pool',
    path: ['sub'],
  });
export type AuthIdentity = z.output<typeof authIdentitySchema>;

/** Columns of a new `users` row (Drizzle insert names). */
export interface NewUserValues {
  authPool: AuthPool;
  authSubject: string;
  role: UserRole;
  email: string | null;
  name: string | null;
}

/** The row to insert for an identity seen for the first time. */
export function newUserForIdentity(identity: AuthIdentity): NewUserValues {
  const valid = authIdentitySchema.parse(identity);
  return {
    authPool: valid.pool,
    authSubject: valid.sub,
    role: valid.pool === 'admins' ? 'admin' : 'user',
    email: valid.email,
    name: valid.name,
  };
}

/** Code of the trial plan (seeded by packages/db; the only plan with `trial_days`). */
export const TRIAL_PLAN_CODE = 'trial';

export interface TrialSubscriptionValues {
  status: 'trial';
  billing: BillingMode;
  periodEnd: Date;
  cancelAtPeriodEnd: false;
}

/**
 * Photographer onboarding (`POST /me/photographer`), idempotent, in one transaction:
 *
 *   UPDATE users SET role = 'photographer' WHERE id = $me AND role = 'user' RETURNING id
 *     -- no row: already a photographer (or an admin): answer with the current state
 *   INSERT INTO subscriptions (photographer_id, plan_id, ...) trial plan, values below
 *   INSERT INTO storage_usage (photographer_id) VALUES ($me) ON CONFLICT DO NOTHING
 *
 * The row lock of the UPDATE serialises concurrent calls, and `subscriptions_one_live_per_photographer`
 * backs it up, so nobody gets two trials. `trialDays` is the trial plan's `trial_days` (14).
 */
export function trialSubscription(now: Date, trialDays: number): TrialSubscriptionValues {
  if (!Number.isInteger(trialDays) || trialDays < 1) {
    throw new RangeError(`trialDays must be a positive integer, got ${trialDays}`);
  }
  return {
    status: 'trial',
    billing: 'prepaid',
    periodEnd: new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
  };
}
