import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai, Space_Grotesk } from 'next/font/google';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { GoogleAnalytics } from '@/components/site/google-analytics';
import { processAnalyticsId } from '@/lib/server/config';
import { analyticsAllowed, PATHNAME_HEADER } from '@/lib/site/analytics-paths';
import { HTML_LANG } from '@/i18n/config';
import './globals.css';

/*
 * Fonts are downloaded at build time and served from /_next/static (CSP font-src 'self'): no
 * request to a font CDN at run time. Both are variable fonts, so every weight (400 to 700) comes from one file each.
 */
const notoSansThai = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  variable: '--font-noto-thai',
  display: 'swap',
});
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
/** ADR 0024: the studio's figures and Latin headings. */
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('title'), description: t('description') };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request: the CSP nonce from src/proxy.ts must reach Next's scripts.
  await connection();
  const locale = await getLocale();
  const requestHeaders = await headers();
  // ADR 0017, but never on the pages with a token in the URL (analyticsAllowed).
  const analytics = analyticsAllowed(requestHeaders.get(PATHNAME_HEADER))
    ? processAnalyticsId()
    : null;
  const nonce = analytics === null ? undefined : (requestHeaders.get('x-nonce') ?? undefined);
  return (
    <html
      lang={HTML_LANG[locale]}
      className={`${notoSansThai.variable} ${inter.variable} ${spaceGrotesk.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
        {analytics !== null ? <GoogleAnalytics id={analytics} nonce={nonce} /> : null}
      </body>
    </html>
  );
}
