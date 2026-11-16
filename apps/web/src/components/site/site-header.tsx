import { PACKAGES_SECTION_PATH } from '@shotx/shared';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { viewerState } from '@/lib/server/auth';
import { LanguageSwitcher } from './language-switcher';
import { SnapLogo } from './snap-logo';

/** Where a signed-in visitor goes instead of the sign-in page. */
const STUDIO_PATH = '/studio';

/**
 * The header of the public pages (ADR 0026, the owner's mockup): the camera-face mark and the
 * SNAP wordmark, "packages and pricing", the language switcher, and "sign in" (or "go to the
 * studio" when this browser has a session: the cookies are read on the server, no API call). No
 * sign-up link: Free and paid accounts start from the package cards.
 */
export async function SiteHeader() {
  const t = await getTranslations('site');
  const { signedIn } = await viewerState();
  return (
    <header className="border-b border-[#dce6ee] bg-white">
      <div className="mx-auto flex h-[78px] max-w-[1200px] items-center gap-3 px-[18px] sm:px-6">
        <Link
          href="/"
          aria-label={t('homeLabel')}
          className="flex items-center gap-2.5 rounded-md text-[25px] font-black tracking-[1px] text-[#092e50] outline-none focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329]"
        >
          <SnapLogo />
          SNAP
        </Link>
        <nav aria-label={t('navLabel')} className="ml-auto flex items-center gap-1 sm:gap-3">
          <Link
            href={PACKAGES_SECTION_PATH}
            className="hidden rounded-md px-2 py-2 text-sm text-[#667888] transition-colors hover:text-[#092e50] sm:block"
          >
            {t('packages')}
          </Link>
          <LanguageSwitcher className="text-[#092e50]" />
          <Link
            href={signedIn ? STUDIO_PATH : AUTH_PATHS.loginPage}
            className="inline-flex h-11 items-center rounded-[10px] bg-[#092e50] px-4 text-sm font-bold text-white transition-colors hover:bg-[#0c3d69] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#f1a329] sm:h-10"
          >
            {signedIn ? t('studio') : t('login')}
          </Link>
        </nav>
      </div>
    </header>
  );
}

/** The footer of the public pages: one navy line, as in the mockup. */
export async function SiteFooter() {
  const t = await getTranslations('site');
  return (
    <footer className="bg-[#092e50] px-6 py-6 text-center text-[13px] text-[#c7d7e5]">
      {t('footer')}
    </footer>
  );
}
