'use client';

import { Button, cn, Sheet, SheetContent, SheetTitle } from '@shotx/ui';
import { ApertureIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { parseSearch, SEARCH_PATH } from '@/lib/drive/search-params';
import type { ClientStudioConfig } from '@/lib/server/config';
import { AccountMenu, type StudioUser } from './account-menu';
import { ActAsBanner } from './act-as-banner';
import { NewMenu } from './new-menu';
import { SearchBar } from './search-bar';
import { SidebarNav } from './sidebar-nav';
import { StorageMeter } from './storage-meter';
import { StudioProvider } from './studio-context';

/**
 * The studio frame:
 * - phones (< md): a top bar with the menu button; the aside is a slide-over drawer;
 * - tablets in portrait (md to lg): a collapsible rail of icons beside the content;
 * - tablets in landscape and desktops (lg and up): the full aside.
 * The top bar holds the search, "+ New" (studio.new) and the account menu.
 */
export function StudioShellView({
  pathname,
  user,
  banner,
  initialSearch,
  onSearch,
  config,
  nav,
  children,
}: {
  config?: ClientStudioConfig;
  /** Tests pass a platform (Mac or Windows). */
  nav?: Navigator;
  pathname: string;
  user: StudioUser | null;
  banner?: ReactNode;
  initialSearch?: ReturnType<typeof parseSearch>;
  onSearch: (href: string) => void;
  children: ReactNode;
}) {
  const t = useTranslations();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const rail = !railExpanded;

  // ADR 0024: the brand block, a gradient aperture over "Snap · Studio".
  const logo = (
    <Link
      href="/studio"
      className="flex items-center gap-2.5 rounded-lg px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white shadow-[0_0_20px_-4px_rgb(99_102_241/0.6)]"
        aria-hidden
      >
        <ApertureIcon className="size-5" />
      </span>
      <span className="leading-none">
        <span className="block font-display text-lg font-bold tracking-[-0.02em]">
          {t('common.appName')}
        </span>
        <span className="block text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          {t('studio.brandTag')}
        </span>
      </span>
    </Link>
  );

  return (
    <StudioProvider config={config} nav={nav}>
      {/* studio-theme: the dark studio look (ADR 0024, globals.css). */}
      <div className="studio-theme flex min-h-dvh bg-background">
        <aside
          data-expanded={railExpanded}
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 flex-col gap-6 overflow-y-auto border-r border-white/5 bg-sidebar px-3 py-4 transition-[width] duration-200 md:flex lg:w-64',
            railExpanded ? 'md:w-64' : 'md:w-[4.75rem]',
          )}
        >
          <div className={cn('flex h-11 items-center gap-2', rail && 'md:max-lg:justify-center')}>
            <span className={cn(rail && 'md:max-lg:hidden')}>{logo}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto size-11 lg:hidden"
              aria-label={railExpanded ? t('studio.collapseNav') : t('studio.expandNav')}
              aria-expanded={railExpanded}
              onClick={() => setRailExpanded((v) => !v)}
            >
              {railExpanded ? (
                <PanelLeftCloseIcon aria-hidden />
              ) : (
                <PanelLeftOpenIcon aria-hidden />
              )}
            </Button>
          </div>
          <SidebarNav pathname={pathname} rail={rail} />
          <div className="studio-card mt-auto p-3">
            {rail ? (
              <>
                <div className="lg:hidden">
                  <StorageMeter compact />
                </div>
                <div className="hidden lg:block">
                  <StorageMeter />
                </div>
              </>
            ) : (
              <StorageMeter />
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <ActAsBanner />
          <header className="sticky top-0 z-40 flex h-[4.25rem] items-center gap-2 border-b border-white/5 bg-background/85 px-3 backdrop-blur-xl sm:gap-3 sm:px-5">
            <Button
              variant="ghost"
              size="icon"
              className="size-11 md:hidden"
              aria-label={t('studio.openMenu')}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon aria-hidden />
            </Button>
            <div className="min-w-0 max-w-2xl flex-1">
              <SearchBar
                key={pathname === SEARCH_PATH ? JSON.stringify(initialSearch) : 'search'}
                initial={initialSearch}
                onSearch={onSearch}
              />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <NewMenu />
              <AccountMenu user={user} />
            </div>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 px-3 pt-4 pb-40 sm:px-6 sm:pt-6">
            {banner}
            {children}
          </main>
        </div>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" closeLabel={t('common.close')} aria-describedby={undefined}>
          <SheetTitle asChild>
            <div className="flex h-11 items-center">{logo}</div>
          </SheetTitle>
          <SidebarNav pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
          <div className="studio-card mt-auto p-3">
            <StorageMeter />
          </div>
        </SheetContent>
      </Sheet>
    </StudioProvider>
  );
}

/** {@link StudioShellView} wired to the App Router (current path, search params, navigation). */
export function StudioShell({
  user,
  banner,
  config,
  children,
}: {
  user: StudioUser | null;
  banner?: ReactNode;
  config: ClientStudioConfig;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '/studio';
  const params = useSearchParams();
  const router = useRouter();
  return (
    <StudioShellView
      pathname={pathname}
      user={user}
      banner={banner}
      initialSearch={
        pathname === SEARCH_PATH ? parseSearch(new URLSearchParams(params.toString())) : undefined
      }
      onSearch={(href) => router.push(href)}
      config={config}
    >
      {children}
    </StudioShellView>
  );
}
