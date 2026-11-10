import { z } from 'zod';
import { SUBSCRIPTION_STATUSES } from '../domain';
import { idSchema, isoDateTimeSchema } from './common';

/**
 * The signed-in user (users pool; admins use the admin app). The guard provisions the `users` row
 * on the first request (newUserForIdentity), so every users-pool identity has one.
 */
export const meResponseSchema = z.object({
  id: idSchema,
  /**
   * `photographer` for accounts an admin created (ADR 0010) and photographers from before it;
   * `user` for viewers (LINE/Google). Nobody becomes a photographer through this API any more.
   */
  role: z.enum(['user', 'photographer']),
  email: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  /** The latest subscription (photographers only; null for viewers). */
  subscription: z
    .object({
      status: z.enum(SUBSCRIPTION_STATUSES),
      planCode: z.string(),
      periodEnd: isoDateTimeSchema,
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  /** Feature flags the studio needs (FACE_SEARCH_ENABLED: show face-index controls). */
  features: z.object({ faceSearch: z.boolean() }),
  /**
   * ADR 0010: the session is restricted until the photographer changes their temporary password
   * (PASSWORD_CHANGE_CLAIM; other routes answer PASSWORD_CHANGE_REQUIRED). GET /me still works,
   * so a reloaded studio can show the change form. Always false for viewers.
   */
  passwordChangeRequired: z.boolean(),
});
export type MeResponse = z.output<typeof meResponseSchema>;

/**
 * @deprecated ADR 0010 removed self-serve onboarding: only an admin creates photographer accounts
 * (POST /admin/users). `POST /me/photographer` now answers FORBIDDEN for everyone and will be
 * deleted from the contract once api and web no longer reference it.
 *
 * Former behaviour: role `photographer` plus a 14-day `trial` subscription on the trial plan and
 * a storage_usage row, in one transaction (see trialSubscription).
 */
export const becomePhotographerBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
});
export type BecomePhotographerBody = z.input<typeof becomePhotographerBodySchema>;
