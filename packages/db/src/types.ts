import type {
  activityEvents,
  adminCredentials,
  authSessions,
  auditLog,
  cashPayments,
  checkoutSessions,
  consents,
  dailyStats,
  faceDeletions,
  faceFeedback,
  faces,
  files,
  folders,
  paymentWebhookEvents,
  payments,
  plans,
  shareDailyStats,
  shares,
  storageUsage,
  subscriptionEvents,
  subscriptionNotices,
  subscriptions,
  userPasswordCredentials,
  users,
  zipJobEntries,
  zipJobs,
} from './schema/index';

// Row types: `X` is what a select returns, `NewX` what an insert accepts.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type StorageUsage = typeof storageUsage.$inferSelect;
export type NewStorageUsage = typeof storageUsage.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type DriveFile = typeof files.$inferSelect;
export type NewDriveFile = typeof files.$inferInsert;
export type Face = typeof faces.$inferSelect;
export type NewFace = typeof faces.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type Consent = typeof consents.$inferSelect;
export type NewConsent = typeof consents.$inferInsert;
export type FaceFeedback = typeof faceFeedback.$inferSelect;
export type NewFaceFeedback = typeof faceFeedback.$inferInsert;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
export type DailyStats = typeof dailyStats.$inferSelect;
export type NewDailyStats = typeof dailyStats.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type ZipJob = typeof zipJobs.$inferSelect;
export type NewZipJob = typeof zipJobs.$inferInsert;
export type ZipJobEntry = typeof zipJobEntries.$inferSelect;
export type NewZipJobEntry = typeof zipJobEntries.$inferInsert;
export type FaceDeletion = typeof faceDeletions.$inferSelect;
export type NewFaceDeletion = typeof faceDeletions.$inferInsert;
export type ShareDailyStats = typeof shareDailyStats.$inferSelect;
export type NewShareDailyStats = typeof shareDailyStats.$inferInsert;
export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert;
export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
export type NewPaymentWebhookEvent = typeof paymentWebhookEvents.$inferInsert;
export type SubscriptionNotice = typeof subscriptionNotices.$inferSelect;
export type NewSubscriptionNotice = typeof subscriptionNotices.$inferInsert;
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
export type AdminCredentials = typeof adminCredentials.$inferSelect;
export type NewAdminCredentials = typeof adminCredentials.$inferInsert;
export type UserPasswordCredentials = typeof userPasswordCredentials.$inferSelect;
export type NewUserPasswordCredentials = typeof userPasswordCredentials.$inferInsert;
export type CashPayment = typeof cashPayments.$inferSelect;
export type NewCashPayment = typeof cashPayments.$inferInsert;
