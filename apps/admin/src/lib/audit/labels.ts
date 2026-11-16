import {
  ADMIN_AUDIT_ACTIONS,
  AUTH_AUDIT_ACTIONS,
  type AuditAction,
  FINANCE_AUDIT_ACTIONS,
  isAuditAction,
  PACKAGE_AUDIT_ACTIONS,
} from '@shotx/shared';

/**
 * The audit-log viewer's action groups (ADR 0027 §1), in AUDIT_ACTIONS' order, each with the
 * `action` filter values (prefixes or exact actions, OR-ed by the api) that match every action of
 * the group: the package group needs `account.self_signup` beside `package.`.
 */
export const AUDIT_GROUPS = {
  auth: { filter: ['auth.'], actions: AUTH_AUDIT_ACTIONS },
  admin: { filter: ['admin.'], actions: ADMIN_AUDIT_ACTIONS },
  package: { filter: ['package.', 'account.self_signup'], actions: PACKAGE_AUDIT_ACTIONS },
  finance: { filter: ['finance.'], actions: FINANCE_AUDIT_ACTIONS },
} as const;

export type AuditGroup = keyof typeof AUDIT_GROUPS;
export const AUDIT_GROUP_IDS = Object.keys(AUDIT_GROUPS) as AuditGroup[];

/** `a.b.c` → `a-b-c`: message keys can't contain dots; actions never contain `-`. */
export type AuditLabelKey<A extends string> = A extends `${infer Head}.${infer Rest}`
  ? `${Head}-${AuditLabelKey<Rest>}`
  : A;

export function auditLabelKey<A extends AuditAction>(action: A): AuditLabelKey<A> {
  return action.replaceAll('.', '-') as AuditLabelKey<A>;
}

/**
 * The `action` query of a filter: the exact action, else the group's values comma-separated
 * (auditActionFilterListSchema), else none.
 */
export function actionFilterOf(
  group: AuditGroup | null,
  action: AuditAction | null,
): string | undefined {
  if (action !== null) return action;
  return group === null ? undefined : AUDIT_GROUPS[group].filter.join(',');
}

/** The label of an action in the UI language, or the raw string for an action outside the list. */
export function auditActionLabel(
  action: string,
  translate: (key: AuditLabelKey<AuditAction>) => string,
): string {
  return isAuditAction(action) ? translate(auditLabelKey(action)) : action;
}
