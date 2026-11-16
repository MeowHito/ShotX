import { SIGNUP_CONFIRM_PATH } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { analyticsAllowed } from './analytics-paths';

describe('Google Analytics pages (ADR 0017, 0025, 0026)', () => {
  it('is off on the pages with a token in the URL fragment', () => {
    expect(analyticsAllowed(SIGNUP_CONFIRM_PATH)).toBe(false);
    expect(analyticsAllowed('/signup/confirm/')).toBe(false);
    expect(analyticsAllowed('/reset-password')).toBe(false);
  });

  it('is on everywhere else, and when the path is unknown', () => {
    for (const path of ['/', '/login', '/forgot-password', '/checkout/return', '/studio', null]) {
      expect(analyticsAllowed(path), String(path)).toBe(true);
    }
  });
});
