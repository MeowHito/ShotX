import { Button } from '@shotx/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { TRASH_HREF } from '@/components/drive/paths';
import { UsageBar } from '@/components/drive/usage-bar';
import { UploadPanel } from '@/components/upload/upload-panel';
import { UploadProvider } from '@/components/upload/upload-context';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { viewerState } from '@/lib/server/auth';
import { clientUploadConfig } from '@/lib/server/config';

export default async function StudioLayout({ children }: { children: ReactNode }) {
  const viewer = await viewerState();
  if (!viewer.signedIn) redirect(`${AUTH_PATHS.loginPage}?next=/studio`);
  const t = await getTranslations('studio');

  return (
    <UploadProvider config={clientUploadConfig()}>
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link href="/studio" className="font-bold">
            ShotX
          </Link>
          <nav aria-label={t('navLabel')} className="flex gap-1 text-sm">
            <Link href="/studio" className="rounded-md px-2 py-1 hover:bg-accent">
              {t('drive')}
            </Link>
            <Link href={TRASH_HREF} className="rounded-md px-2 py-1 hover:bg-accent">
              {t('trash')}
            </Link>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {viewer.user?.name || viewer.user?.email ? (
              <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                {viewer.user.name ?? viewer.user.email}
              </span>
            ) : null}
            <form action={AUTH_PATHS.logout} method="post">
              <Button type="submit" variant="ghost" size="sm">
                {t('logout')}
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-4 pb-40">
        <UsageBar />
        {children}
      </main>
      <UploadPanel />
    </UploadProvider>
  );
}
