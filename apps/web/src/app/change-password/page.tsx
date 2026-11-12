import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChangePasswordScreen } from '@/components/auth/change-password-screen';
import { LanguageSwitcher } from '@/components/site/language-switcher';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { afterPasswordChangePath, changePasswordPageHref } from '@/lib/auth/password-client';
import { viewerState } from '@/lib/server/auth';
import { clientPasswordPolicy } from '@/lib/server/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('password');
  return { title: t('requiredTitle') };
}

/**
 * `/change-password?next=…`: the forced change of a temporary password (ADR 0010). Outside the
 * studio layout on purpose: a restricted session may only call GET /me and the password change,
 * so nothing here loads the drive.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = afterPasswordChangePath(typeof params.next === 'string' ? params.next : null);
  const viewer = await viewerState();
  if (!viewer.signedIn) {
    redirect(
      `${AUTH_PATHS.loginPage}?${new URLSearchParams({ next: changePasswordPageHref(next) }).toString()}`,
    );
  }
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
      <div className="w-full max-w-sm rounded-2xl border bg-background p-6 shadow-float sm:p-8">
        <ChangePasswordScreen
          email={viewer.user?.email ?? null}
          minLength={clientPasswordPolicy().minLength}
          next={next}
        />
      </div>
    </main>
  );
}
