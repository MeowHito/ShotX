import { buttonVariants } from '@shotx/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('home');
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-3xl font-bold">{t('heading')}</h1>
      <p className="text-muted-foreground">{t('body')}</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/studio" className={buttonVariants()}>
          {t('goToStudio')}
        </Link>
        <Link href="/login" className={buttonVariants({ variant: 'outline' })}>
          {t('login')}
        </Link>
      </div>
    </main>
  );
}
