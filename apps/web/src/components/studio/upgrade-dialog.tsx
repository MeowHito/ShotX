'use client';

import { type MyPackage, type PublicPackage, STUDIO_PACKAGE_PATH } from '@shotx/shared';
import {
  Alert,
  Button,
  buttonVariants,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shotx/ui';
import { SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { usePackageOffers } from '@/lib/packages/queries';
import { PackageDialog } from '../packages/package-dialog';
import { PackageOffers } from './my-package-page';

/**
 * The sidebar's "upgrade" button (ADR 0032): opens a popup with the package and what the account
 * can buy (more days, more photos, renewal). Choosing a card closes the popup and opens the buy
 * dialog (coupon, VAT, pay page). Only rendered for an account with a package (the chip decides).
 * `compact`: the tablet rail's icon button, `label` as its accessible name.
 */
export function UpgradeButton({
  pkg,
  expired,
  compact = false,
  label,
  now,
}: {
  pkg: MyPackage;
  expired: boolean;
  compact?: boolean;
  label?: string;
  now: Date;
}) {
  const tp = useTranslations('studio.package');
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<PublicPackage | null>(null);
  const text = expired ? tp('renew') : tp('upgrade');
  return (
    <>
      {compact ? (
        <Button
          variant="outline"
          size="icon"
          aria-label={label ?? text}
          title={label ?? text}
          data-testid="upgrade-button"
          className={cn(
            'mx-auto size-11 rounded-full',
            expired && 'border-destructive/50 text-destructive',
          )}
          onClick={() => setOpen(true)}
        >
          <SparklesIcon aria-hidden />
        </Button>
      ) : (
        <Button
          size="sm"
          data-testid="upgrade-button"
          className="h-11 w-full rounded-full sm:h-9"
          onClick={() => setOpen(true)}
        >
          <SparklesIcon aria-hidden />
          {text}
        </Button>
      )}
      <UpgradeDialog
        open={open}
        onOpenChange={setOpen}
        pkg={pkg}
        now={now}
        onChoose={(choice) => {
          setOpen(false);
          setChosen(choice);
        }}
      />
      <UpgradeCheckout chosen={chosen} onClose={() => setChosen(null)} />
    </>
  );
}

function UpgradeDialog({
  open,
  onOpenChange,
  pkg,
  now,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pkg: MyPackage;
  now: Date;
  onChoose: (pkg: PublicPackage) => void;
}) {
  const t = useTranslations('studio.myPackage');
  const tc = useTranslations('common');
  const offers = usePackageOffers({ enabled: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tc('close')}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl"
        data-testid="upgrade-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold tracking-[-0.02em]">
            {t('upgradeTitle')}
          </DialogTitle>
          <DialogDescription>{t('upgradeIntro')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {offers.isError ? (
            <Alert variant="destructive" className="flex items-center justify-between gap-3">
              <span>{t('loadFailed')}</span>
              <Button size="sm" variant="outline" onClick={() => void offers.refetch()}>
                {t('retry')}
              </Button>
            </Alert>
          ) : offers.data === undefined ? (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              {t('loading')}
            </p>
          ) : (
            <PackageOffers pkg={pkg} offers={offers.data} now={now} onChoose={onChoose} dense />
          )}
        </div>
        <div className="flex justify-end">
          <Link
            href={STUDIO_PACKAGE_PATH}
            onClick={() => onOpenChange(false)}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-11 sm:h-9')}
          >
            {t('seeAll')}
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The buy dialog of the chosen card, with the sales switches of the offers already loaded. */
function UpgradeCheckout({
  chosen,
  onClose,
}: {
  chosen: PublicPackage | null;
  onClose: () => void;
}) {
  const offers = usePackageOffers({ enabled: chosen !== null });
  if (offers.data === undefined) return null;
  return <PackageDialog pkg={chosen} sales={offers.data.sales} signedIn onClose={onClose} />;
}
