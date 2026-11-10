import { adminMfaBodySchema, newPasswordSchema } from '@shotx/shared';
import { z } from 'zod';

/**
 * What the browser exchanges with the admin app's own sign-in route handlers (src/app/auth/*).
 * The API's `challengeId`, access token and refresh token never appear here: the route handlers
 * keep them in httpOnly cookies. Only the step and, for TOTP enrolment, the otpauth URI (the
 * admin's own new secret, shown once) reach the browser.
 */

/** Paths of the sign-in route handlers (same origin, POST, JSON). */
export const SIGN_IN_PATHS = {
  login: '/auth/login',
  password: '/auth/password',
  mfa: '/auth/mfa',
  /** Form POST; redirects to the login page. */
  logout: '/auth/logout',
  loginPage: '/login',
} as const;

export const signInStepViewSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('change_password') }),
  z.object({
    step: z.literal('enrol_totp'),
    otpauthUri: z.string().startsWith('otpauth://totp/').max(2048),
  }),
  z.object({ step: z.literal('totp') }),
  z.object({ step: z.literal('signed_in') }),
]);
export type SignInStepView = z.output<typeof signInStepViewSchema>;

/** Body of POST /auth/password (the challenge comes from the cookie). */
export const passwordStepBodySchema = z.strictObject({ newPassword: newPasswordSchema });
export type PasswordStepBody = z.input<typeof passwordStepBodySchema>;

/** Body of POST /auth/mfa (the challenge comes from the cookie). */
export const mfaStepBodySchema = z.strictObject({ code: adminMfaBodySchema.shape.code });
export type MfaStepBody = z.input<typeof mfaStepBodySchema>;
