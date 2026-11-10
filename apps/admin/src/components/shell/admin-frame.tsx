'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { SessionUser } from '@/lib/auth/session';
import { AdminShell } from './admin-shell';

/** {@link AdminShell} wired to the App Router's current path. */
export function AdminFrame({ user, children }: { user: SessionUser | null; children: ReactNode }) {
  const pathname = usePathname() ?? '/users';
  return (
    <AdminShell pathname={pathname} user={user}>
      {children}
    </AdminShell>
  );
}
