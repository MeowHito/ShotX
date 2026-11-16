import { cn } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

type FeatureId = 'face' | 'upload' | 'watermark' | 'qr' | 'stats' | 'download' | 'gallery';

/** The mockup's line icons (24×24, stroked with the current colour). */
const ICONS: Record<FeatureId, ReactNode> = {
  face: (
    <>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8.5 17c.5-2 1.7-3 3.5-3s3 1 3.5 3" />
    </>
  ),
  upload: <path d="M12 3v12m-4-8 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  watermark: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m4 18 5-5 4 4 3-3 4 4" />
    </>
  ),
  qr: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM15 14h2v2h-2zM20 14v3M14 20h3m3-1v1" />,
  stats: <path d="M4 20V4m0 16h16M8 16v-5m4 5V7m4 9v-3m4 3V5" />,
  download: <path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3" />,
  gallery: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
      <circle cx="16" cy="9" r="1" />
    </>
  ),
};

/** In the mockup's order; the first (face search) is the highlighted navy card. */
const FEATURES: FeatureId[] = ['face', 'upload', 'watermark', 'qr', 'stats', 'download', 'gallery'];

/**
 * "Every package has every feature" (ADR 0026 home page): seven cards, four per row on wide
 * screens and two on tablets and phones, as in the owner's mockup.
 */
export function FeatureGrid() {
  const t = useTranslations('home');
  return (
    <section aria-labelledby="features-title" className="pt-3 pb-12">
      <div className="mb-[22px] text-center">
        <h2
          id="features-title"
          className="mb-[5px] text-[clamp(26px,3vw,34px)] leading-[1.3] font-bold text-[#092e50]"
        >
          {t('featuresTitle')}
        </h2>
        <p className="text-[#667888]">{t('featuresLead')}</p>
      </div>
      <ul className="grid grid-cols-2 gap-2.5 min-[551px]:gap-3.5 min-[1001px]:grid-cols-4">
        {FEATURES.map((id, i) => {
          const primary = i === 0;
          return (
            <li
              key={id}
              className={cn(
                'min-h-[160px] rounded-2xl border p-[15px] shadow-[0_6px_22px_#123c5e0a] min-[551px]:min-h-[166px] min-[551px]:p-[21px]',
                primary ? 'border-[#092e50] bg-[#092e50]' : 'border-[#dce6ee] bg-white',
              )}
            >
              <div
                className={cn(
                  'mb-[13px] grid size-[42px] place-items-center rounded-xl',
                  primary ? 'bg-[#1c507b] text-[#9dd0ff]' : 'bg-[#e8f3ff] text-[#0875e9]',
                )}
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="size-[23px] fill-none stroke-current stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]"
                >
                  {ICONS[id]}
                </svg>
              </div>
              <h3
                className={cn(
                  'mb-[5px] text-sm leading-[1.4] font-bold min-[551px]:text-base',
                  primary ? 'text-white' : 'text-[#092e50]',
                )}
              >
                {t(`features.${id}.title`)}
              </h3>
              <p
                className={cn(
                  'text-xs leading-[1.55] min-[551px]:text-[13px]',
                  primary ? 'text-[#c5d8e9]' : 'text-[#667888]',
                )}
              >
                {t(`features.${id}.body`)}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
