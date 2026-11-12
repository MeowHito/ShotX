import {
  type AdminChangePasswordResponse,
  type AdminLoginResponse,
  adminChangePasswordResponseSchema,
  adminLoginResponseSchema,
} from '@shotx/shared';
import { type AdminOpsContext, createAdmin, type TotpEnrolment } from '../cli/admin-ops';

// Helpers of the admin sign-in tests that run with ADMIN_MFA_MODE=totp (the ADR 0010 flow).

/** The operator CLI's `create` in mode totp: the enrolment it shows (throws in mode off). */
export async function createTotpAdmin(
  ctx: AdminOpsContext,
  input: { email: string; name: string; password: string },
): Promise<TotpEnrolment> {
  const created = await createAdmin(ctx, input);
  if (created.mfa !== 'totp') throw new Error('expected ADMIN_MFA_MODE=totp');
  return created;
}

type Challenge<T> = Exclude<T, { step: 'signed_in' }>;

/** POST /auth/admin/login's answer when it must be a challenge step (mode totp). */
export function challengeStep(body: unknown): Challenge<AdminLoginResponse> {
  const step = adminLoginResponseSchema.parse(body);
  if (step.step === 'signed_in') throw new Error('expected a challenge step, got signed_in');
  return step;
}

/** POST /auth/admin/password's answer when it must be a challenge step (mode totp). */
export function changePasswordChallenge(body: unknown): Challenge<AdminChangePasswordResponse> {
  const step = adminChangePasswordResponseSchema.parse(body);
  if (step.step === 'signed_in') throw new Error('expected a challenge step, got signed_in');
  return step;
}
