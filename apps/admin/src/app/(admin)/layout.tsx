import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminFrame } from '@/components/shell/admin-frame';
import { adminViewerState } from '@/lib/server/auth';

/**
 * Every signed-in page. Without session cookies there is nothing to show (src/proxy.ts already
 * redirects); the API checks the token (admins pool, password + TOTP) on every call.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const viewer = await adminViewerState();
  if (!viewer.signedIn) redirect('/login');
  return <AdminFrame user={viewer.user}>{children}</AdminFrame>;
}
