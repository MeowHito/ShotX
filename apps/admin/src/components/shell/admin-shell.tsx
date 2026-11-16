'use client';

import { Button, cn, Sheet, SheetContent, SheetTitle } from '@shotx/ui';
import {
  GaugeIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  ScrollTextIcon,
  UsersIcon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { LanguageMenu } from '@/components/language-switcher';
import type { SessionUser } from '@/lib/auth/session';
import { SIGN_IN_PATHS } from '@/lib/sign-in/protocol';

type NavId = 'overview' | 'users' | 'finance' | 'auditLog';

const NAV: { id: NavId; href: string; icon: LucideIcon }[] = [
  { id: 'overview', href: '/overview', icon: GaugeIcon },
  { id: 'users', href: '/users', icon: UsersIcon },
  { id: 'finance', href: '/finance', icon: WalletIcon },
  { id: 'auditLog', href: '/audit-log', icon: ScrollTextIcon },
];

export function activeNav(pathname: string): NavId | null {
  if (pathname === '/overview') return 'overview';
  if (pathname === '/finance') return 'finance';
  if (pathname === '/audit-log') return 'auditLog';
  return pathname === '/users' || pathname.startsWith('/users/') ? 'users' : null;
}

function Nav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const t = useTranslations('shell');
  const active = activeNav(pathname);
  return (
    <nav aria-label={t('navLabel')}>
      <ul className="space-y-1">
        {NAV.map(({ id, href, icon: Icon }) => (
          <li key={id}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={id === active ? 'page' : undefined}
              className={cn(
                'flex h-11 items-center gap-3 rounded-lg px-3.5 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                id === active
                  ? 'bg-background font-semibold text-primary shadow-card ring-1 ring-border'
                  : 'text-foreground/80 hover:bg-background/70 hover:text-foreground',
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              {t(id)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Sign out: a same-origin form POST (the route handler revokes the session). */
export function LogoutButton({ className }: { className?: string }) {
  const t = useTranslations('shell');
  return (
    <form method="post" action={SIGN_IN_PATHS.logout} className={className}>
      <Button type="submit" variant="ghost" className="w-full justify-start">
        <LogOutIcon aria-hidden />
        {t('logout')}
      </Button>
    </form>
  );
}

/**
 * The admin frame: the aside (md and up) or a drawer (phones) with the navigation, the signed-in
 * admin, the language switcher and sign out. Same tokens and look as the studio, with an admin
 * badge.
 */
export function AdminShell({
  pathname,
  user,
  children,
}: {
  pathname: string;
  user: SessionUser | null;
  children: ReactNode;
}) {
  const t = useTranslations();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const who = user?.name ?? user?.email ?? null;

  const logo = (
    <Link
      href="/users"
      className="flex items-center gap-2 rounded-md px-1 text-lg font-bold tracking-[-0.015em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t('common.appName')}
      <span className="rounded-md bg-band px-1.5 py-0.5 text-xs font-semibold text-band-foreground">
        {t('common.adminBadge')}
      </span>
    </Link>
  );

  const account = (
    <div className="space-y-2 rounded-xl border bg-background p-3 shadow-card">
      {who !== null ? (
        <p className="truncate px-1 text-xs text-muted-foreground" title={user?.email ?? undefined}>
          {t('shell.signedInAs', { name: who })}
        </p>
      ) : null}
      <LogoutButton />
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-background">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-6 overflow-y-auto border-r bg-sidebar px-3 py-4 md:flex">
        <div className="flex h-11 items-center">{logo}</div>
        <Nav pathname={pathname} />
        <div className="mt-auto">{account}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The top bar: menu and logo on phones (the aside has them on wider screens), and the
            language at the top right on every screen (owner, 2026-11-13). */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:hidden"
            aria-label={t('shell.openMenu')}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon aria-hidden />
          </Button>
          <div className="md:hidden">{logo}</div>
          <LanguageMenu className="ml-auto" />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-3 pt-4 pb-24 sm:px-6 sm:pt-8">
          {children}
        </main>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" closeLabel={t('common.close')} aria-describedby={undefined}>
          <SheetTitle asChild>
            <div className="flex h-11 items-center">{logo}</div>
          </SheetTitle>
          <Nav pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
          <div className="mt-auto">{account}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
