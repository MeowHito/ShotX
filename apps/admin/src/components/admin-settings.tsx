'use client';

import type { AdminMfaMode } from '@shotx/shared';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * Deployment settings the signed-in pages read: ADMIN_MFA_MODE as GET /auth/providers reports it
 * (ADR 0011 decision 4), or null when unknown. TOTP-only UI (the "authenticator pending" flag of
 * AdminUser.totpEnrolled, TOTP notes in dialogs) shows only with `totp`.
 */
const MfaModeContext = createContext<AdminMfaMode | null>(null);

export function AdminSettingsProvider({
  mfaMode,
  children,
}: {
  mfaMode: AdminMfaMode | null;
  children: ReactNode;
}) {
  return <MfaModeContext.Provider value={mfaMode}>{children}</MfaModeContext.Provider>;
}

/** True when admins sign in with TOTP (ADMIN_MFA_MODE=totp). */
export function useTotpEnabled(): boolean {
  return useContext(MfaModeContext) === 'totp';
}
