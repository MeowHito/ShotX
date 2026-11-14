import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/site/language-switcher';

/** The centered card of the sign-in pages (login, forgot and reset password). */
export async function AuthCardShell({ children }: { children: ReactNode }) {
  const tc = await getTranslations('common');
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-16">
      <div className="absolute top-3 right-3">
        <LanguageSwitcher />
      </div>
      <Link
        href="/"
        className="mb-6 rounded-md px-1 text-xl font-bold tracking-[-0.015em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {tc('appName')}
      </Link>
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-background p-6 shadow-float sm:p-8">
        {children}
      </div>
    </main>
  );
}
