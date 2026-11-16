'use client';

import type { CaptchaClientConfig, PackagesResponse, PublicPackage } from '@shotx/shared';
import { cn } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { createTurnstileLoader, type TurnstileLoader } from '@/lib/captcha/turnstile';
import { useFormatSatang } from '@/lib/i18n/use-format';
import { PackageDialog } from './package-dialog';
import { vatPercent } from './vat';

/**
 * The home page's package cards (ADR 0026, the owner's mockup): five columns on wide screens,
 * three on tablets, one on phones. Prices come from GET /packages (rendered on the server, the
 * VAT-exclusive price on the card); the featured card has the blue border and the navy button.
 * "Choose this package" opens {@link PackageDialog}.
 */
export function PackageCards({
  data,
  signedIn,
  captcha = { provider: 'none' },
  loadTurnstile,
}: {
  data: PackagesResponse;
  /** This browser has a session: a paid order is for that account (no name or email asked). */
  signedIn: boolean;
  /** CAPTCHA_PROVIDER as web reads it: Free sign-up shows Turnstile when the API asks. */
  captcha?: CaptchaClientConfig;
  /** Tests pass a fake Turnstile. */
  loadTurnstile?: TurnstileLoader;
}) {
  const t = useTranslations('home');
  const formatSatang = useFormatSatang();
  const [chosen, setChosen] = useState<PublicPackage | null>(null);
  // The script is fetched only when a challenge is shown.
  const [loader] = useState<TurnstileLoader | null>(
    () =>
      loadTurnstile ??
      (captcha.provider === 'turnstile' ? createTurnstileLoader(captcha.scriptUrl) : null),
  );

  if (data.packages.length === 0) {
    return <p className="py-10 text-center text-[#667888]">{t('empty')}</p>;
  }

  return (
    <>
      <ul
        aria-label={t('packagesLabel')}
        className="grid grid-cols-1 items-stretch gap-3.5 min-[651px]:grid-cols-3 min-[1001px]:grid-cols-5"
      >
        {data.packages.map((pkg) => (
          <li
            key={pkg.code}
            data-featured={pkg.featured}
            className={cn(
              'relative flex flex-col rounded-[18px] bg-white p-6 min-[651px]:px-5 min-[651px]:py-[25px]',
              pkg.featured
                ? 'border-2 border-[#0875e9] shadow-[0_12px_35px_#0875e920]'
                : 'border border-[#dce6ee] shadow-[0_9px_25px_#123c5e0a]',
            )}
          >
            <h3
              id={`package-${pkg.code}`}
              className="text-xl leading-snug font-bold text-[#092e50]"
            >
              {pkg.name}
            </h3>
            {pkg.featured ? <span className="sr-only">{t('featured')}</span> : null}
            <p className="my-2 text-[13px] text-[#667888] min-[651px]:min-h-[46px]">
              {t.has(`who.${pkg.code}` as 'who.free') ? t(`who.${pkg.code}` as 'who.free') : null}
            </p>
            <p className="text-[37px] leading-[1.2] font-extrabold tracking-[-1px] text-[#092e50]">
              {formatSatang(pkg.price.priceSatang)}
            </p>
            <p
              className={cn(
                'mt-[13px] mb-[18px] flex items-baseline gap-1.5 rounded-[10px] px-[13px] py-[11px] text-[15px] leading-none font-bold text-[#092e50]',
                pkg.featured ? 'bg-[#dceeff]' : 'bg-[#eaf4ff]',
              )}
            >
              <strong className="text-[30px] font-extrabold tracking-[-0.03em] text-[#0875e9]">
                {pkg.days}
              </strong>
              {t('days')}
            </p>
            <p className="mb-6 border-t border-[#dce6ee] pt-[15px] text-sm text-[#14293b]">
              <strong className="text-lg text-[#092e50]">
                {t('photos', { count: pkg.photoLimit })}
              </strong>
              <br />
              {t('photosLabel')}
            </p>
            <button
              type="button"
              aria-describedby={`package-${pkg.code}`}
              onClick={() => setChosen(pkg)}
              className={cn(
                'mt-auto block w-full cursor-pointer rounded-[10px] border p-2.5 text-center font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329]',
                pkg.featured
                  ? 'border-[#092e50] bg-[#092e50] text-white hover:bg-[#0c3d69]'
                  : 'border-[#bfd0df] bg-white text-[#092e50] hover:bg-[#f3f7fb]',
              )}
            >
              {t('choose')}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-5 mb-[55px] text-center text-[13px] text-[#667888]">
        {t('footnote', { rate: vatPercent(data.vatRateBasisPoints) })}
      </p>
      <PackageDialog
        pkg={chosen}
        sales={data.sales}
        signedIn={signedIn}
        captcha={{ config: captcha, loader }}
        onClose={() => setChosen(null)}
      />
    </>
  );
}
