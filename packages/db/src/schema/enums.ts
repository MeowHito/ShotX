import {
  ACCOUNT_STATUSES,
  ACTIVITY_SOURCES,
  ACTIVITY_TYPES,
  AUTH_POOLS,
  BILLING_ACTORS,
  BILLING_MODES,
  CHECKOUT_CHANGE_TYPES,
  CHECKOUT_STATUSES,
  CONSENT_PURPOSES,
  DOWNLOAD_SIZES,
  EXPENSE_CATEGORIES,
  FACE_FEEDBACK_VERDICTS,
  FILE_STATUSES,
  PACKAGE_KINDS,
  PACKAGE_ORDER_STATUSES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PRINT_APPROVAL_MODES,
  PRINT_ORDER_STATUSES,
  SHARE_MODES,
  SHARE_TARGET_TYPES,
  SUBSCRIPTION_EVENT_TYPES,
  SUBSCRIPTION_NOTICE_KINDS,
  SUBSCRIPTION_STATUSES,
  SUPPORTED_LOCALES,
  USER_ROLES,
  ZIP_JOB_STATUSES,
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
export const activitySource = pgEnum('activity_source', ACTIVITY_SOURCES);
export const zipJobStatus = pgEnum('zip_job_status', ZIP_JOB_STATUSES);
// Migration 0004.
export const consentPurpose = pgEnum('consent_purpose', CONSENT_PURPOSES);
export const checkoutChangeType = pgEnum('checkout_change_type', CHECKOUT_CHANGE_TYPES);
export const checkoutStatus = pgEnum('checkout_status', CHECKOUT_STATUSES);
export const paymentEventType = pgEnum('payment_event_type', PAYMENT_EVENT_TYPES);
export const subscriptionEventType = pgEnum('subscription_event_type', SUBSCRIPTION_EVENT_TYPES);
export const subscriptionNoticeKind = pgEnum('subscription_notice_kind', SUBSCRIPTION_NOTICE_KINDS);
export const billingActor = pgEnum('billing_actor', BILLING_ACTORS);
// Migration 0012 (ADR 0011).
export const uiLocale = pgEnum('ui_locale', SUPPORTED_LOCALES);
// Migration 0011 (ADR 0010).
export const accountStatus = pgEnum('account_status', ACCOUNT_STATUSES);
// Migration 0016 (ADR 0026).
export const packageOrderStatus = pgEnum('package_order_status', PACKAGE_ORDER_STATUSES);
// Migration 0022 (ADR 0032).
export const packageKind = pgEnum('package_kind', PACKAGE_KINDS);
// Migration 0017 (ADR 0027).
export const expenseCategory = pgEnum('expense_category', EXPENSE_CATEGORIES);

// ADR 0031: print orders.
export const printOrderStatus = pgEnum('print_order_status', PRINT_ORDER_STATUSES);
export const printApproval = pgEnum('print_approval', PRINT_APPROVAL_MODES);
