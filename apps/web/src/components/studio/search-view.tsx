'use client';

import type { DriveItem } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { DetailsPanel } from '@/components/drive/details-panel';
import { DriveGrid } from '@/components/drive/drive-grid';
import { ItemCard } from '@/components/drive/item-card';
import { folderHref } from '@/components/drive/paths';
import { useDriveSearch } from '@/lib/drive/queries';
import { type DriveSearch, toSearchQuery } from '@/lib/drive/search-params';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { GridSkeleton } from './recent-view';

/** The active filters as readable chips. */
function FilterChips({ search }: { search: DriveSearch }) {
  const ts = useTranslations('search');
  const format = useFormatter();
  const day = (value: string) =>
    format.dateTime(new Date(`${value}T00:00:00+07:00`), { dateStyle: 'medium' });
  const range = (from: string | null, to: string | null) =>
    from !== null && to !== null
      ? ts('rangeBoth', { from: day(from), to: day(to) })
      : from !== null
        ? ts('rangeFrom', { from: day(from) })
        : to !== null
          ? ts('rangeTo', { to: day(to) })
          : null;
  const chips: string[] = [];
  if (search.type !== null) chips.push(ts('chips.type', { type: ts(`types.${search.type}`) }));
  const taken = range(search.takenFrom, search.takenTo);
  if (taken !== null) chips.push(ts('chips.taken', { range: taken }));
  const uploaded = range(search.uploadedFrom, search.uploadedTo);
  if (uploaded !== null) chips.push(ts('chips.uploaded', { range: uploaded }));
  if (search.folderId !== null) chips.push(ts('chips.folder'));
  if (chips.length === 0) return null;
  return (
    <ul aria-label={ts('activeFilters')} className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <li key={chip} className="rounded-full border bg-surface px-3 py-1 text-xs">
          {chip}
        </li>
      ))}
    </ul>
  );
}

/** Search results (GET /drive/search): each with where it is; folders open, files show details. */
export function SearchView({ search }: { search: DriveSearch }) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const query = toSearchQuery(search);
  const results = useDriveSearch(query);
  const [details, setDetails] = useState<DriveItem | null>(null);
  const rows = results.results.map((r) => ({ ...r, id: r.item.id }));

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl break-words">
          {search.q !== '' ? t('search.titleQuery', { q: search.q }) : t('search.title')}
        </h1>
        <FilterChips search={search} />
      </header>
      {query === null ? (
        <p className="rounded-2xl bg-sidebar px-6 py-12 text-center text-sm text-muted-foreground">
          {t('search.prompt')}
        </p>
      ) : results.isError ? (
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('search.loadError')}: {describe(results.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void results.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : results.isPending ? (
        <GridSkeleton count={5} />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-sidebar px-6 py-16 text-center">
          <p className="text-base font-medium">{t('search.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('search.emptyHint')}</p>
        </div>
      ) : (
        <>
          {results.truncated ? <Alert variant="warning">{t('search.truncated')}</Alert> : null}
          <DriveGrid
            items={rows}
            layout="list"
            label={t('search.resultsLabel')}
            loadingMoreLabel={t('drive.loadingMore')}
            hasNextPage={results.hasNextPage}
            isFetchingNextPage={results.isFetchingNextPage}
            fetchNextPage={results.fetchNextPage}
            renderItem={({ item, ancestors }) => (
              <ItemCard
                item={item}
                layout="list"
                selected={false}
                selectable={false}
                onToggleSelect={() => undefined}
                onPrimaryClick={item.kind === 'file' ? () => setDetails(item) : undefined}
                onPreview={() => setDetails(item)}
                href={item.kind === 'folder' ? folderHref(item.id) : null}
                subtitle={[t('drive.root'), ...ancestors.map((a) => a.name)].join(' › ')}
              />
            )}
          />
        </>
      )}
      <DetailsPanel item={details} onOpenChange={(open) => !open && setDetails(null)} />
    </div>
  );
}
