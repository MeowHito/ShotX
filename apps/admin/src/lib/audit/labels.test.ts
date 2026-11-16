import { AUDIT_ACTIONS, auditActionFilterListSchema, isAuditActionPrefix } from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { LOCALES, MESSAGES } from '@/i18n/config';
import {
  actionFilterOf,
  AUDIT_GROUP_IDS,
  AUDIT_GROUPS,
  auditActionLabel,
  auditLabelKey,
} from './labels';

describe('audit action labels (ADR 0027 §1)', () => {
  it.each(LOCALES)('every AUDIT_ACTIONS value has a %s label, and nothing else does', (locale) => {
    const labels = MESSAGES[locale].auditLog.actions as Record<string, string>;
    expect(Object.keys(labels).sort()).toEqual(AUDIT_ACTIONS.map(auditLabelKey).sort());
    const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'auditLog' });
    for (const action of AUDIT_ACTIONS) {
      const label = auditActionLabel(action, (key) => t(`actions.${key}`));
      expect(label, action).not.toBe(action);
      expect(label.trim(), action).not.toBe('');
    }
  });

  it('shows an action outside the list as stored', () => {
    expect(auditActionLabel('takedown.share', () => 'never')).toBe('takedown.share');
  });

  it('groups every action once, and each group filter matches exactly its actions', () => {
    expect(AUDIT_GROUP_IDS.flatMap((g) => AUDIT_GROUPS[g].actions)).toEqual([...AUDIT_ACTIONS]);
    for (const group of AUDIT_GROUP_IDS) {
      const values = auditActionFilterListSchema.parse(actionFilterOf(group, null));
      const matched = AUDIT_ACTIONS.filter((action) =>
        values.some((v) => (isAuditActionPrefix(v) ? action.startsWith(v) : action === v)),
      );
      expect(matched, group).toEqual([...AUDIT_GROUPS[group].actions]);
    }
    expect(actionFilterOf('package', null)).toBe('package.,account.self_signup');
    expect(actionFilterOf('finance', null)).toBe('finance.');
    expect(actionFilterOf('finance', 'finance.expense_deleted')).toBe('finance.expense_deleted');
    expect(actionFilterOf(null, null)).toBeUndefined();
    expect(auditLabelKey('admin.cash_payment.created')).toBe('admin-cash_payment-created');
  });
});
