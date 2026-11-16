import { describe, expect, it } from 'vitest';
import { activeNav } from './admin-shell';

describe('activeNav', () => {
  it('marks the finance and activity log pages', () => {
    expect(activeNav('/finance')).toBe('finance');
    expect(activeNav('/audit-log')).toBe('auditLog');
    expect(activeNav('/users/abc')).toBe('users');
    expect(activeNav('/nope')).toBeNull();
  });
});
