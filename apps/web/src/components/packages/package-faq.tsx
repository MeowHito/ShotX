import { type MediaKind, type PackagesResponse, UPLOAD_FILE_TYPES } from '@shotx/shared';
import { useTranslations } from 'next-intl';
import { useFormatBytes, useFormatSatang } from '@/lib/i18n/use-format';
import { vatPercent } from './vat';

/** In the mockup's order; the first is open. Keys of `home.faq.items`. */
const FAQ_ITEMS = [
  'perAccount',
  'period',
  'counting',
  'faceSearch',
  'downloads',
  'files',
  'vat',
  'more',
  'payment',
  'faceData',
] as const;
type FaqItem = (typeof FAQ_ITEMS)[number];

/** The upload allowlist of one kind as the copy names it, e.g. `JPEG, PNG, WEBP`. */
export function uploadTypeLabels(kind: MediaKind): string {
  return UPLOAD_FILE_TYPES.filter((type) => type.kind === kind)
    .map((type) => (type.extensions.at(-1) ?? '').toUpperCase())
    .join(', ');
}

/**
 * The terms and FAQ section under the package cards (ADR 0027 §6, the mockup's FAQ rewritten to
 * ADR 0026's behaviour): a native details/summary accordion, the first item open. The VAT answer
 * lists each paid package's total from the same GET /packages data as the cards; the file answer
 * shows the per-file limits of the upload config when web could read them.
 */
export function PackageFaq({
  data,
  maxBytes,
}: {
  /** GET /packages, or null when it failed (the VAT answer then names no amounts). */
  data: PackagesResponse | null;
  /** UPLOAD_MAX_IMAGE_BYTES / UPLOAD_MAX_VIDEO_BYTES; null when the config can't be read. */
  maxBytes: Readonly<Record<MediaKind, number>> | null;
}) {
  const t = useTranslations('home.faq');
  const formatSatang = useFormatSatang();
  const formatBytes = useFormatBytes();
  const paid = data?.packages.filter((pkg) => !pkg.free) ?? [];

  function answer(item: FaqItem) {
    if (item === 'files') {
      const types = {
        imageTypes: uploadTypeLabels('image'),
        videoTypes: uploadTypeLabels('video'),
      };
      return (
        <p className={ANSWER}>
          {maxBytes === null
            ? t('items.files.answerNoLimits', types)
            : t('items.files.answer', {
                ...types,
                imageMax: formatBytes(maxBytes.image),
                videoMax: formatBytes(maxBytes.video),
              })}
        </p>
      );
    }
    if (item === 'vat') {
      if (data === null) return <p className={ANSWER}>{t('items.vat.answerNoData')}</p>;
      const rate = vatPercent(data.vatRateBasisPoints);
      return (
        <>
          <p className={ANSWER}>
            {t('items.vat.answer', { rate })}
            {paid.length > 0 ? ` ${t('items.vat.totalsIntro')}` : null}
          </p>
          {paid.length > 0 ? (
            <ul className="mt-2 mb-0.5 list-disc pl-5 text-[15px] text-[#516475]">
              {paid.map((pkg) => (
                <li key={pkg.code}>
                  {t('items.vat.total', {
                    name: pkg.name,
                    total: formatSatang(pkg.price.totalSatang),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
    }
    return <p className={ANSWER}>{t(`items.${item}.answer`)}</p>;
  }

  return (
    <section
      id="conditions"
      aria-labelledby="conditions-title"
      className="mx-auto mb-[70px] max-w-[850px] scroll-mt-6"
    >
      <h2
        id="conditions-title"
        className="mb-2 text-center text-[26px] leading-[1.3] font-bold text-[#092e50] min-[651px]:text-[30px]"
      >
        {t('title')}
      </h2>
      <p className="mb-7 text-center text-[#667888]">{t('lead')}</p>
      {FAQ_ITEMS.map((item, index) => (
        <details
          key={item}
          open={index === 0}
          className="my-2.5 rounded-xl border border-[#dce6ee] bg-white px-5 py-4"
        >
          <summary className="cursor-pointer font-bold text-[#092e50] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329]">
            {t(`items.${item}.question`)}
          </summary>
          {answer(item)}
        </details>
      ))}
    </section>
  );
}

const ANSWER = 'mt-3 mb-0.5 text-[15px] text-[#516475]';
