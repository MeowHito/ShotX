'use client';

import { cn } from '@shotx/ui';
import {
  ClockIcon,
  CreditCardIcon,
  HardDriveIcon,
  LinkIcon,
  type LucideIcon,
  PaletteIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  BILLING_HREF,
  DESIGNS_HREF,
  RECENT_HREF,
  SHARES_HREF,
  TRASH_HREF,
} from '@/components/drive/paths';
import { useStudio } from './studio-context';

export type StudioNavId = 'drive' | 'recent' | 'shares' | 'designs' | 'trash' | 'billing';

const NAV: { id: StudioNavId; href: string; icon: LucideIcon }[] = [
  { id: 'drive', href: '/studio', icon: HardDriveIcon },
  { id: 'recent', href: RECENT_HREF, icon: ClockIcon },
  { id: 'shares', href: SHARES_HREF, icon: LinkIcon },
  { id: 'designs', href: DESIGNS_HREF, icon: PaletteIcon },
  { id: 'trash', href: TRASH_HREF, icon: Trash2Icon },
  { id: 'billing', href: BILLING_HREF, icon: CreditCardIcon },
];

/** Which aside item a studio path belongs to (search belongs to none). */
export function activeNav(pathname: string): StudioNavId | null {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (pathname === '/studio' || under('/studio/folders')) return 'drive';
  if (under(RECENT_HREF)) return 'recent';
  if (under(SHARES_HREF)) return 'shares';
  if (under(DESIGNS_HREF)) return 'designs';
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
                    ? 'bg-background font-semibold text-primary shadow-card ring-1 ring-border'
                    : 'text-foreground/80 hover:bg-background/70 hover:text-foreground',
                  rail && 'md:max-lg:justify-center md:max-lg:px-0',
                )}
              >
                <Icon
                  className={cn(
                    'size-5 shrink-0',
                    current ? 'text-primary' : 'text-muted-foreground',
                  )}
                  aria-hidden
                />
                <span className={cn('truncate', rail && 'md:max-lg:sr-only')}>{t(id)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
