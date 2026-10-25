'use client';

import { Alert, Button } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useShares } from '@/lib/studio/queries';
import { ShareRow } from './share-row';

/** Every share of the photographer, newest first, with cursor pagination. */
export function SharesList() {
  const t = useTranslations();
  const describe = useErrorMessage();
  const shares = useShares();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('shares.title')}</h1>
      {shares.isError ? (
        <Alert variant="destructive">{describe(shares.error)}</Alert>
      ) : shares.isPending ? (
        <p role="status" className="text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : shares.items.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed p-8 text-center text-muted-foreground">
          {t('shares.empty')}
        </p>
      ) : (
        <ul aria-label={t('shares.listLabel')} className="grid gap-3">
          {shares.items.map((share) => (
            <li key={share.id}>
              <ShareRow share={share} />
            </li>
          ))}
        </ul>
      )}
      {shares.hasNextPage ? (
        <Button
          variant="outline"
          onClick={() => void shares.fetchNextPage()}
          disabled={shares.isFetchingNextPage}
        >
          {shares.isFetchingNextPage ? t('shares.loadingMore') : t('shares.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
