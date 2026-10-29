'use client';

import type { DriveFile } from '@shotx/shared';
import { Alert, Button, Skeleton } from '@shotx/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { DetailsPanel } from '@/components/drive/details-panel';
import { DriveGrid } from '@/components/drive/drive-grid';
import { ItemCard } from '@/components/drive/item-card';
import { useRecent } from '@/lib/drive/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useLayoutPreference } from '@/lib/studio/view-preference';
import { useStudio } from './studio-context';

/** Loading placeholders shaped like the grid. */
export function GridSkeleton({ count = 10 }: { count?: number }) {
  const tc = useTranslations('common');
  return (
    <div role="status" aria-label={tc('loading')}>
      <span className="sr-only">{tc('loading')}</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl p-1.5">
            <Skeleton className="aspect-square w-full rounded-lg" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Recent (studio.recent): the newest files (GET /drive/recent); a file opens its details. */
export function RecentView() {
  const t = useTranslations();
  const format = useFormatter();
  const describe = useErrorMessage();
  const studio = useStudio();
  const recent = useRecent({ processingPollMs: studio.config.processingPollMs });
  const [layout] = useLayoutPreference();
  const [details, setDetails] = useState<DriveFile | null>(null);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('recent.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('recent.description')}</p>
      </header>
      {recent.isError ? (
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('recent.loadError')}: {describe(recent.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void recent.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : recent.isPending ? (
        <GridSkeleton />
      ) : recent.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-sidebar px-6 py-16 text-center">
          <p className="text-base font-medium">{t('recent.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('recent.emptyHint')}</p>
        </div>
      ) : (
        <DriveGrid
          items={recent.items}
          layout={layout}
          label={t('recent.title')}
          loadingMoreLabel={t('drive.loadingMore')}
          hasNextPage={recent.hasNextPage}
          isFetchingNextPage={recent.isFetchingNextPage}
          fetchNextPage={recent.fetchNextPage}
          renderItem={(file) => (
            <ItemCard
              item={file}
              layout={layout}
              selected={false}
              selectable={false}
              onToggleSelect={() => undefined}
              onPrimaryClick={() => setDetails(file)}
              onPreview={() => setDetails(file)}
              href={null}
              subtitle={t('recent.uploadedAt', {
                date: format.dateTime(new Date(file.createdAt), { dateStyle: 'medium' }),
              })}
            />
          )}
        />
      )}
      <DetailsPanel item={details} onOpenChange={(open) => !open && setDetails(null)} />
    </div>
  );
}
