'use client';

import { type MyPackage, packageDaysLeft, STUDIO_PACKAGE_PATH } from '@shotx/shared';
import { Alert, buttonVariants, cn } from '@shotx/ui';
import { TicketIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useMyPackage } from '@/lib/packages/queries';

/** The chip's text: days left (or expired), and the photos used of the limit. */
function usePackageText(pkg: MyPackage, now: Date) {
  const t = useTranslations('studio.package');
  const days = packageDaysLeft({ expiresAt: new Date(pkg.expiresAt) }, now);
  const expired = pkg.expired || days === 0;
  return {
    expired,
    name: t('name', { name: pkg.name }),
    days: expired ? t('expired') : t('daysLeft', { days }),
    photos: t('photos', { used: pkg.photosUsed, limit: pkg.photoLimit }),
  };
}

/**
 * The photographer's package in the studio aside (ADR 0026): name · days left · photos used of
 * the limit, and "renew" to the studio's package page (ADR 0032). Renders nothing for an unlimited
 * account (GET /me/package is null: every admin-created account) or before the answer arrives.
 * `compact`: the tablet rail (an icon that links to the packages, the text as its label).
 */
export function PackageChip({ compact = false, now }: { compact?: boolean; now?: Date }) {
  const pkg = useMyPackage();
  if (pkg.data === undefined || pkg.data === null) return null;
  return <PackageChipView pkg={pkg.data} compact={compact} now={now} />;
}

function PackageChipView({
  pkg,
  compact,
  now: fixedNow,
}: {
  pkg: MyPackage;
  compact: boolean;
  now?: Date;
}) {
  const t = useTranslations('studio.package');
  const format = useFormatter();
  const [now] = useState(() => fixedNow ?? new Date());
  const text = usePackageText(pkg, now);
  const expiresAt = t('expiresAt', {
    date: format.dateTime(new Date(pkg.expiresAt), { dateStyle: 'medium' }),
  });

  if (compact) {
    const label = `${text.name} · ${text.days} · ${text.photos}`;
    return (
      <Link
        href={STUDIO_PACKAGE_PATH}
        aria-label={label}
        title={label}
        data-testid="package-chip"
        className={cn(
          buttonVariants({ variant: 'outline', size: 'icon' }),
          'mx-auto size-11 rounded-full',
          text.expired && 'border-destructive/50 text-destructive',
        )}
      >
        <TicketIcon aria-hidden />
      </Link>
    );
  }

  return (
    <section
      aria-label={t('title')}
      data-testid="package-chip"
      data-expired={text.expired}
      className="space-y-1.5 text-xs"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <TicketIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{text.name}</span>
      </div>
      <p className="flex flex-wrap gap-x-1.5 text-muted-foreground">
        <span
          className={cn(text.expired && 'font-semibold text-destructive')}
          title={text.expired ? undefined : expiresAt}
        >
          {text.days}
        </span>
        <span aria-hidden>·</span>
        <span>{text.photos}</span>
      </p>
      <Link
        href={STUDIO_PACKAGE_PATH}
        className={cn(
          buttonVariants({ variant: text.expired ? 'default' : 'outline', size: 'sm' }),
          'h-11 w-full rounded-full sm:h-9',
        )}
      >
        {t('renew')}
      </Link>
    </section>
  );
}

/**
 * ADR 0026: the studio-wide notice while the package has expired. Uploads, new shares and face
 * indexing are refused and every share link is closed until the photographer renews; browsing,
 * renaming, deleting and their own downloads keep working.
 */
export function PackageExpiredBanner() {
  const t = useTranslations('studio.package');
  const pkg = useMyPackage();
  if (pkg.data === undefined || pkg.data === null || !pkg.data.expired) return null;
  return (
    <Alert
      variant="warning"
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <span>{t('expiredBanner')}</span>
      <Link
        href={STUDIO_PACKAGE_PATH}
        className={cn(buttonVariants({ size: 'sm' }), 'h-11 shrink-0 rounded-full sm:h-9')}
      >
        {t('renew')}
      </Link>
    </Alert>
  );
}
