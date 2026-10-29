import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai } from 'next/font/google';
import { connection } from 'next/server';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
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
  return (
    <html lang={locale} className={`${notoSansThai.variable} ${inter.variable}`}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
