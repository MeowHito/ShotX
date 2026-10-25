import {
  ACTIVITY_TYPES,
  AUTH_POOLS,
  BILLING_MODES,
  DOWNLOAD_SIZES,
  FACE_FEEDBACK_VERDICTS,
  FILE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SHARE_MODES,
  SHARE_TARGET_TYPES,
  SUBSCRIPTION_STATUSES,
  USER_ROLES,
} from '@shotx/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

// Values come from @shotx/shared so the API schemas and the database never drift. Adding a value
// needs a migration (ALTER TYPE ... ADD VALUE); removing one needs a data migration first.
export const userRole = pgEnum('user_role', USER_ROLES);
export const authPool = pgEnum('auth_pool', AUTH_POOLS);
export const subscriptionStatus = pgEnum('subscription_status', SUBSCRIPTION_STATUSES);
export const billingMode = pgEnum('billing_mode', BILLING_MODES);
export const paymentMethod = pgEnum('payment_method', PAYMENT_METHODS);
export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
export const fileStatus = pgEnum('file_status', FILE_STATUSES);
export const shareTargetType = pgEnum('share_target_type', SHARE_TARGET_TYPES);
export const shareMode = pgEnum('share_mode', SHARE_MODES);
export const downloadSize = pgEnum('download_size', DOWNLOAD_SIZES);
export const faceFeedbackVerdict = pgEnum('face_feedback_verdict', FACE_FEEDBACK_VERDICTS);
export const activityType = pgEnum('activity_type', ACTIVITY_TYPES);
