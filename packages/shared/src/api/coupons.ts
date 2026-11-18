import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common';
import { COUPON_CODE_PATTERN, couponCodeSchema, couponPercentSchema } from './packages';

// Admin coupons (ADR 0030). An admin creates a code worth 1–100% off a package's VAT-exclusive
// price with a number of uses; buyers type it in the buy dialog. Coupons are never deleted (orders
// keep their coupon): an admin switches one off, or changes its uses or expiry.

/** Most uses one coupon can have. */
export const COUPON_MAX_REDEMPTIONS_LIMIT = 1_000_000;

/** Longest `package_coupons.note` (the `package_coupons_note_length` CHECK). */
export const COUPON_NOTE_MAX_LENGTH = 200;

/** Most coupons GET /admin/coupons lists (newest first). */
export const ADMIN_COUPON_LIST_LIMIT = 500;

const maxRedemptionsSchema = z.number().int().min(1).max(COUPON_MAX_REDEMPTIONS_LIMIT);

/**
 * One coupon with its use counts. `paidCount`: paid orders with it. `holdingCount`: pending or
 * failed orders created less than PACKAGE_COUPON_HOLD_SECONDS ago, each holding one use. A new
 * order is refused (COUPON_USED_UP) once `paidCount + holdingCount >= maxRedemptions`.
 */
export const adminCouponSchema = z.object({
  id: idSchema,
  code: z.string().regex(COUPON_CODE_PATTERN),
  percentOff: couponPercentSchema,
  maxRedemptions: maxRedemptionsSchema,
  paidCount: z.number().int().nonnegative(),
  holdingCount: z.number().int().nonnegative(),
  /** After this the code is COUPON_INVALID; null: no expiry. */
  expiresAt: isoDateTimeSchema.nullable(),
  isActive: z.boolean(),
  note: z.string().nullable(),
  createdById: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AdminCoupon = z.output<typeof adminCouponSchema>;

/** GET /admin/coupons: every coupon, newest first (at most ADMIN_COUPON_LIST_LIMIT). */
export const listCouponsResponseSchema = z.object({ items: z.array(adminCouponSchema) });
export type ListCouponsResponse = z.output<typeof listCouponsResponseSchema>;

const noteSchema = z
  .string()
  .trim()
  .max(COUPON_NOTE_MAX_LENGTH)
  .transform((n) => (n === '' ? undefined : n))
  .optional();

/**
 * POST /admin/coupons (201, the coupon): audited `finance.coupon_created` in the same transaction.
 * A code already taken (case-insensitive) is CONFLICT; an `expiresAt` in the past is
 * VALIDATION_FAILED.
 */
export const createCouponBodySchema = z.strictObject({
  code: couponCodeSchema,
  percentOff: couponPercentSchema,
  maxRedemptions: maxRedemptionsSchema,
  expiresAt: isoDateTimeSchema.optional(),
  note: noteSchema,
});
export type CreateCouponBody = z.input<typeof createCouponBodySchema>;

/**
 * PATCH /admin/coupons/:id (200, the coupon): switch on or off, change the uses or the expiry
 * (null removes it). At least one field. Audited `finance.coupon_updated` with only what changed;
 * nothing changed: no audit row. Lowering `maxRedemptions` below the uses already taken is allowed
 * (no new order can take one).
 */
export const updateCouponBodySchema = z
  .strictObject({
    isActive: z.boolean().optional(),
    maxRedemptions: maxRedemptionsSchema.optional(),
    expiresAt: isoDateTimeSchema.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    error: 'must change something',
  });
export type UpdateCouponBody = z.input<typeof updateCouponBodySchema>;

// --- Audit metas -----------------------------------------------------------------------------------

const change = <T extends z.ZodType>(schema: T) => z.object({ from: schema, to: schema });

export const COUPON_AUDIT_META_SCHEMAS = {
  'finance.coupon_created': z.object({
    code: z.string().regex(COUPON_CODE_PATTERN),
    percentOff: couponPercentSchema,
    maxRedemptions: maxRedemptionsSchema,
    expiresAt: isoDateTimeSchema.nullable(),
  }),
  'finance.coupon_updated': z.object({
    code: z.string().regex(COUPON_CODE_PATTERN),
    changes: z.object({
      isActive: change(z.boolean()).optional(),
      maxRedemptions: change(maxRedemptionsSchema).optional(),
      expiresAt: change(isoDateTimeSchema.nullable()).optional(),
    }),
  }),
} as const;
