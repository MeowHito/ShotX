'use client';

import { cn } from '@shotx/ui';
import {
  CalendarDaysIcon,
  ClockIcon,
  CreditCardIcon,
  FolderSyncIcon,
  type LucideIcon,
  PaletteIcon,
  PrinterIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  BILLING_HREF,
  DESIGNS_HREF,
  PRINT_HREF,
  RECENT_HREF,
  SHARES_HREF,
  SYNC_HREF,
  TRASH_HREF,
} from '@/components/drive/paths';
import { useOptionalFolderSync } from '@/components/sync/folder-sync-context';
import { useStudio } from './studio-context';

export type StudioNavId = 'drive' | 'recent' | 'designs' | 'sync' | 'print' | 'trash' | 'billing';

const NAV: { id: StudioNavId; href: string; icon: LucideIcon }[] = [
  { id: 'drive', href: '/studio', icon: CalendarDaysIcon },
  { id: 'recent', href: RECENT_HREF, icon: ClockIcon },
  { id: 'designs', href: DESIGNS_HREF, icon: PaletteIcon },
  { id: 'sync', href: SYNC_HREF, icon: FolderSyncIcon },
  { id: 'print', href: PRINT_HREF, icon: PrinterIcon },
  { id: 'trash', href: TRASH_HREF, icon: Trash2Icon },
  { id: 'billing', href: BILLING_HREF, icon: CreditCardIcon },
];

/** Which aside item a studio path belongs to (search belongs to none). */
export function activeNav(pathname: string): StudioNavId | null {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  // ADR 0023: links are managed from the events, so the links page belongs to them.
  if (pathname === '/studio' || under('/studio/folders') || under(SHARES_HREF)) return 'drive';
  if (under(RECENT_HREF)) return 'recent';
  if (under(DESIGNS_HREF)) return 'designs';
  if (under(SYNC_HREF)) return 'sync';
  if (under(PRINT_HREF)) return 'print';
  if (under(TRASH_HREF)) return 'trash';
  if (under(BILLING_HREF)) return 'billing';
  return null;
}

/**
 * The studio's main navigation. `rail` is the tablet rail (icons; labels for screen readers and
 * tooltips) up to `lg`, where the full aside always shows labels. "Plans and payment" only while
 * photographers can pay online (BILLING_MODE=gateway; ADR 0010).
 */
export function SidebarNav({
  pathname,
  rail = false,
  onNavigate,
}: {
  pathname: string;
  rail?: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations('studio');
  const { config } = useStudio();
  const active = activeNav(pathname);
  const syncing = useOptionalFolderSync()?.snapshot.status === 'running';
  const items = NAV.filter(({ id }) => id !== 'billing' || config.billingMode === 'gateway');
  return (
    <nav aria-label={t('navLabel')}>
      <ul className="space-y-1">
        {items.map(({ id, href, icon: Icon }) => {
          const current = id === active;
          return (
            <li key={id}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                title={rail ? t(id) : undefined}
                className={cn(
                  'flex h-11 items-center gap-3 rounded-lg px-3.5 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  current
                    ? 'bg-accent font-semibold text-primary shadow-[inset_2px_0_0_0_var(--color-ring)] dark:text-cyan-300'
                    : 'text-foreground/75 hover:bg-foreground/5 hover:text-foreground',
                  rail && 'md:max-lg:justify-center md:max-lg:px-0',
                )}
              >
                <Icon
                  className={cn(
                    'size-5 shrink-0',
                    current ? 'text-primary dark:text-cyan-300' : 'text-muted-foreground',
                  )}
                  aria-hidden
                />
                <span className={cn('truncate', rail && 'md:max-lg:sr-only')}>{t(id)}</span>
                {id === 'sync' && syncing ? (
                  <span
                    className={cn(
                      'ml-auto size-2 shrink-0 rounded-full bg-green-500 motion-safe:animate-pulse',
                      rail && 'md:max-lg:hidden',
                    )}
                    data-testid="sync-running-dot"
                    title={t('syncRunning')}
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
