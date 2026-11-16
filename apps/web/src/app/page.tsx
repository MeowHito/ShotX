import { type CaptchaClientConfig, loadCaptchaClientConfig } from '@shotx/shared';
import { Alert } from '@shotx/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FeatureGrid } from '@/components/packages/feature-grid';
import { PackageCards } from '@/components/packages/package-cards';
import { PackageFaq } from '@/components/packages/package-faq';
import { SiteFooter, SiteHeader } from '@/components/site/site-header';
import { requestServerCallContext, viewerState } from '@/lib/server/auth';
import { clientUploadConfig, webConfig } from '@/lib/server/config';
import { fetchPackages } from '@/lib/server/packages';

/** The per-file upload limits for the FAQ (UPLOAD_MAX_*_BYTES); null when the config is broken. */
function uploadLimits(): { image: number; video: number } | null {
  try {
    return clientUploadConfig().maxBytes;
  } catch {
    return null;
  }
}

/** The Free sign-up's captcha (CAPTCHA_PROVIDER); a misconfiguration never takes the page down. */
function signupCaptcha(): CaptchaClientConfig {
  try {
    return loadCaptchaClientConfig(process.env);
  } catch {
    return { provider: 'none' };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('home');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

/**
 * The public home page (ADR 0026): the owner's package page (`snap-pricing 2.html`). Hero, the
 * features every package has, and the package cards (id `packages`, the target of `/pricing`
 * and the studio's "renew") with prices from GET /packages, rendered on the server, then the
 * FAQ (ADR 0027 §6). Light, in the mockup's colours, on every device.
 */
export default async function HomePage() {
  const t = await getTranslations('home');
  const [packages, viewer] = await Promise.all([
    fetchPackages({
      apiInternalUrl: webConfig().apiInternalUrl,
      context: await requestServerCallContext(),
    }),
    viewerState(),
  ]);
  return (
    <div className="flex min-h-dvh flex-col bg-[#f3f7fb] leading-[1.6] text-[#14293b]">
      <SiteHeader />
      <main id="top" className="mx-auto w-full max-w-[1200px] flex-1 px-[18px] sm:px-6">
        <section className="pt-10 pb-7 text-center sm:pt-[62px] sm:pb-[35px]">
          <p className="text-sm font-extrabold tracking-[0.08em] text-[#0875e9]">{t('eyebrow')}</p>
          <h1 className="my-3 text-[clamp(32px,5vw,54px)] leading-[1.2] font-bold tracking-[-0.03em] text-[#092e50]">
            {t('headingLine1')}
            <br />
            {t('headingLine2')}
          </h1>
          <p className="text-lg text-[#667888]">{t('lead')}</p>
        </section>

        <FeatureGrid />

        <section id="packages" aria-labelledby="packages-title" className="scroll-mt-6">
          <div className="mb-[22px] text-center">
            <h2
              id="packages-title"
              className="mb-[5px] text-[clamp(26px,3vw,34px)] leading-[1.3] font-bold text-[#092e50]"
            >
              {t('packagesTitle')}
            </h2>
            <p className="text-[#667888]">{t('packagesLead')}</p>
          </div>
          {packages === null ? (
            <Alert variant="destructive" className="mx-auto mb-[55px] max-w-md text-center">
              {t('loadError')}
            </Alert>
          ) : (
            <PackageCards data={packages} signedIn={viewer.signedIn} captcha={signupCaptcha()} />
          )}
        </section>

        <PackageFaq data={packages} maxBytes={uploadLimits()} />
      </main>
      <SiteFooter />
    </div>
  );
}
