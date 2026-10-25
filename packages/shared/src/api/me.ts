import { z } from 'zod';
import { SUBSCRIPTION_STATUSES } from '../domain';
import { idSchema, isoDateTimeSchema } from './common';

/**
 * The signed-in user (users pool; admins use the admin app). The guard provisions the `users` row
 * on the first request (newUserForIdentity), so every users-pool identity has one.
 */
export const meResponseSchema = z.object({
  id: idSchema,
  /** `user` (viewer) until POST /me/photographer. */
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
});
export type MeResponse = z.output<typeof meResponseSchema>;

/**
 * Become a photographer: role `photographer` plus a 14-day `trial` subscription on the trial plan
 * and a storage_usage row, in one transaction (see trialSubscription). Idempotent: a photographer
 * gets their current state, and nobody gets a second trial. `name` sets the display name shown on
 * share pages when given.
 */
export const becomePhotographerBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
});
export type BecomePhotographerBody = z.input<typeof becomePhotographerBodySchema>;
