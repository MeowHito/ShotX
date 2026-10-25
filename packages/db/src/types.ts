import type {
  activityEvents,
  auditLog,
  consents,
  dailyStats,
  faceFeedback,
  faces,
  files,
  folders,
  payments,
  plans,
  shares,
  storageUsage,
  subscriptions,
  users,
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
