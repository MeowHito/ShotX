'use client';

import {
  type MyPackage,
  type PackageKind,
  type PackagesResponse,
  packageDaysLeft,
  photosRemaining,
  type PublicPackage,
} from '@shotx/shared';
import { Alert, Button, cn } from '@shotx/ui';
import { CalendarPlusIcon, ImagePlusIcon, RefreshCwIcon, TicketIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useId, useState } from 'react';
import { useFormatSatang } from '@/lib/i18n/use-format';
import { useMyPackage, usePackageOffers } from '@/lib/packages/queries';
import { PackageDialog } from '../packages/package-dialog';

/**
 * `/studio/package` (ADR 0032): the photographer's package, and what they can buy for it — more
 * days, more photos, or a plan again (renewal). Each card opens the home page's buy dialog
 * (coupon, VAT, pay page) as the signed-in account. An unlimited account (no package) is told
 * there is nothing to buy.
 */
export function MyPackagePage({ now: fixedNow }: { now?: Date } = {}) {
  const t = useTranslations('studio.myPackage');
  const mine = useMyPackage();
  const offers = usePackageOffers();
  const [now] = useState(() => fixedNow ?? new Date());
  const [chosen, setChosen] = useState<PublicPackage | null>(null);

  let body: ReactNode = null;
  if (mine.isError || offers.isError) {
    body = (
      <Alert variant="destructive" className="flex items-center justify-between gap-3">
        <span>{t('loadFailed')}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void Promise.all([mine.refetch(), offers.refetch()])}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (mine.data === null) {
    body = <Alert>{t('unlimited')}</Alert>;
  } else if (mine.data !== undefined && offers.data !== undefined) {
    body = (
      <PackageOffers
        pkg={mine.data}
        offers={offers.data}
        now={now}
        onChoose={(choice) => setChosen(choice)}
      />
    );
  }

  return (
    <div className="w-full space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>
      {body}
      {offers.data !== undefined ? (
        <PackageDialog
          pkg={chosen}
          sales={offers.data.sales}
          signedIn
          onClose={() => setChosen(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The package and its offers by kind: the studio page, and the sidebar's upgrade popup (`dense`:
 * narrower card grid for the dialog).
 */
export function PackageOffers({
  pkg,
  offers,
  now,
  onChoose,
  dense = false,
}: {
  pkg: MyPackage;
  offers: PackagesResponse;
  now: Date;
  onChoose: (pkg: PublicPackage) => void;
  dense?: boolean;
}) {
  const t = useTranslations('studio.myPackage');
  const of = (kind: PackageKind) => offers.packages.filter((p) => p.kind === kind);
  const expired = pkg.expired || packageDaysLeft({ expiresAt: new Date(pkg.expiresAt) }, now) === 0;
  return (
    <>
      <CurrentPackage pkg={pkg} expired={expired} now={now} />
      <OfferSection
        title={t('daysTitle')}
        intro={t('daysIntro')}
        icon={<CalendarPlusIcon className="size-5" aria-hidden />}
        items={of('days')}
        dense={dense}
        onChoose={onChoose}
      />
      <OfferSection
        title={t('photosTitle')}
        intro={t('photosIntro')}
        icon={<ImagePlusIcon className="size-5" aria-hidden />}
        items={of('photos')}
        disabledNote={expired ? t('photosNeedDays') : null}
        dense={dense}
        onChoose={onChoose}
      />
      <OfferSection
        title={t('plansTitle')}
        intro={t('plansIntro')}
        icon={<RefreshCwIcon className="size-5" aria-hidden />}
        items={of('plan')}
        dense={dense}
        onChoose={onChoose}
      />
    </>
  );
}

function CurrentPackage({ pkg, expired, now }: { pkg: MyPackage; expired: boolean; now: Date }) {
  const t = useTranslations('studio.myPackage');
  const tp = useTranslations('studio.package');
  const format = useFormatter();
  const heading = useId();
  const date = format.dateTime(new Date(pkg.expiresAt), { dateStyle: 'medium' });
  const days = packageDaysLeft({ expiresAt: new Date(pkg.expiresAt) }, now);
  return (
    <section
      aria-labelledby={heading}
      data-testid="current-package"
      data-expired={expired}
      className="studio-card flex flex-wrap items-center gap-x-6 gap-y-3 p-4 sm:p-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        <TicketIcon className="size-6 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h2 id={heading} className="text-sm text-muted-foreground">
            {t('current')}
          </h2>
          <p className="truncate text-lg font-semibold">{tp('name', { name: pkg.name })}</p>
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="sr-only">{tp('title')}</dt>
          <dd className={cn(expired && 'font-semibold text-destructive')}>
            {expired
              ? t('expiredOn', { date })
              : `${tp('daysLeft', { days })} · ${t('expiresOn', { date })}`}
          </dd>
        </div>
        <div>
          <dt className="sr-only">{t('photosTitle')}</dt>
          <dd>
            {tp('photos', { used: pkg.photosUsed, limit: pkg.photoLimit })}
            {' · '}
            {t('photosLeft', { count: photosRemaining(pkg) })}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function OfferSection({
  title,
  intro,
  icon,
  items,
  disabledNote = null,
  dense,
  onChoose,
}: {
  title: string;
  intro: string;
  icon: ReactNode;
  items: PublicPackage[];
  disabledNote?: string | null;
  dense: boolean;
  onChoose: (pkg: PublicPackage) => void;
}) {
  const t = useTranslations('studio.myPackage');
  const formatSatang = useFormatSatang();
  const heading = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={heading} className="studio-card space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h2 id={heading} className="flex items-center gap-2 text-lg">
          {icon}
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      {disabledNote !== null ? <Alert variant="warning">{disabledNote}</Alert> : null}
      <ul
        className={cn(
          'grid grid-cols-1 gap-3 min-[480px]:grid-cols-2',
          dense ? 'md:grid-cols-4' : 'lg:grid-cols-4',
        )}
      >
        {items.map((pkg) => (
          <li
            key={pkg.code}
            data-testid={`offer-${pkg.code}`}
            className="flex flex-col gap-3 rounded-xl border border-border p-4"
          >
            <p className="text-xl font-bold tabular-nums">{offerHeadline(pkg, t)}</p>
            {pkg.kind === 'plan' ? (
              <p className="-mt-2 text-sm text-muted-foreground">
                {t('planTerms', { days: pkg.days, photos: pkg.photoLimit })}
              </p>
            ) : null}
            <p className="text-sm">
              <span className="text-base font-semibold tabular-nums">
                {formatSatang(pkg.price.priceSatang)}
              </span>{' '}
              <span className="text-muted-foreground">{t('exVat')}</span>
            </p>
            <Button
              className="mt-auto h-11 rounded-full sm:h-9"
              variant={pkg.kind === 'plan' ? 'outline' : 'default'}
              disabled={disabledNote !== null}
              aria-label={`${t('buy')} ${offerHeadline(pkg, t)}`}
              onClick={() => onChoose(pkg)}
            >
              {t('buy')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A card's headline: "+3 days", "+1,000 photos" (in the UI language), or a plan's name. */
function offerHeadline(
  pkg: PublicPackage,
  t: ReturnType<typeof useTranslations<'studio.myPackage'>>,
): string {
  if (pkg.kind === 'days') return t('addDays', { days: pkg.days });
  if (pkg.kind === 'photos') return t('addPhotos', { photos: pkg.photoLimit });
  return pkg.name;
}
