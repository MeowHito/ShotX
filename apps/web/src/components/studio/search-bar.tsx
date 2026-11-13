'use client';

import type { MediaKind } from '@shotx/shared';
import {
  Button,
  Checkbox,
  cn,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@shotx/ui';
import { SearchIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  type DriveSearch,
  EMPTY_SEARCH,
  filterCount,
  MAX_QUERY_LENGTH,
  rangeInvalid,
  searchHref,
} from '@/lib/drive/search-params';
import { shortcutHint } from '@/lib/studio/shortcuts';
import { useStudio } from './studio-context';

/**
 * The top-bar search: plain text plus filters (photo or video, date taken, date uploaded, this
 * folder only) in a small popover. Submitting goes to the search page; `/` focuses the field.
 */
export function SearchBar({
  initial = EMPTY_SEARCH,
  onSearch,
}: {
  initial?: DriveSearch;
  onSearch: (href: string) => void;
}) {
  const t = useTranslations('search');
  const studio = useStudio();
  const [search, setSearch] = useState<DriveSearch>(initial);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ids = { type: useId(), taken: useId(), uploaded: useId(), folder: useId() };

  const { register } = studio;
  useEffect(() => register({ focusSearch: () => input.current?.focus() }), [register]);

  const invalid =
    rangeInvalid(search.takenFrom, search.takenTo) ||
    rangeInvalid(search.uploadedFrom, search.uploadedTo);
  const count = filterCount(search);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (invalid) {
      setFiltersOpen(true);
      return;
    }
    setFiltersOpen(false);
    onSearch(searchHref(search));
  }

  const set = (patch: Partial<DriveSearch>) => setSearch((prev) => ({ ...prev, ...patch }));
  const day = (value: string) => (value === '' ? null : value);

  return (
    <form role="search" aria-label={t('label')} onSubmit={submit} className="relative w-full">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        ref={input}
        type="search"
        name="q"
        value={search.q}
        maxLength={MAX_QUERY_LENGTH}
        onChange={(e) => set({ q: e.currentTarget.value })}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        aria-keyshortcuts="/"
        enterKeyHint="search"
        className="h-11 rounded-xl border-white/5 bg-surface pr-12 pl-10 focus-visible:border-ring focus-visible:bg-surface"
      />
      <kbd
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-12 hidden -translate-y-1/2 rounded border bg-background px-1.5 text-xs text-muted-foreground lg:block"
      >
        {shortcutHint('search', studio.apple)}
      </kbd>
      <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('filters')}
            className={cn(
              'absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              count > 0 && 'text-primary',
            )}
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden />
            {count > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] leading-none text-primary-foreground">
                {count}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label={t('filters')} className="space-y-4">
          <fieldset className="space-y-2">
            <legend id={ids.type} className="text-sm font-medium">
              {t('type')}
            </legend>
            <div role="radiogroup" aria-labelledby={ids.type} className="flex gap-1.5">
              {([null, 'image', 'video'] as (MediaKind | null)[]).map((value) => (
                <button
                  key={value ?? 'any'}
                  type="button"
                  role="radio"
                  aria-checked={search.type === value}
                  onClick={() => set({ type: value })}
                  className={cn(
                    'h-10 flex-1 rounded-full border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    search.type === value
                      ? 'border-primary bg-accent font-medium text-accent-foreground'
                      : 'hover:bg-muted',
                  )}
                >
                  {t(`types.${value ?? 'any'}`)}
                </button>
              ))}
            </div>
          </fieldset>
          {(
            [
              ['taken', 'takenFrom', 'takenTo'],
              ['uploaded', 'uploadedFrom', 'uploadedTo'],
            ] as const
          ).map(([label, from, to]) => (
            <fieldset key={label} className="space-y-2">
              <legend className="text-sm font-medium">{t(label)}</legend>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor={`${ids[label]}-from`} className="text-xs text-muted-foreground">
                    {t('from')}
                  </Label>
                  <Input
                    id={`${ids[label]}-from`}
                    type="date"
                    value={search[from] ?? ''}
                    max={search[to] ?? undefined}
                    onChange={(e) => set({ [from]: day(e.currentTarget.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${ids[label]}-to`} className="text-xs text-muted-foreground">
                    {t('to')}
                  </Label>
                  <Input
                    id={`${ids[label]}-to`}
                    type="date"
                    value={search[to] ?? ''}
                    min={search[from] ?? undefined}
                    onChange={(e) => set({ [to]: day(e.currentTarget.value) })}
                  />
                </div>
              </div>
            </fieldset>
          ))}
          <div className="flex items-center gap-3">
            <Checkbox
              id={ids.folder}
              checked={search.folderId !== null}
              disabled={studio.currentFolderId === null && search.folderId === null}
              onCheckedChange={(checked) =>
                set({ folderId: checked === true ? studio.currentFolderId : null })
              }
            />
            <Label htmlFor={ids.folder} className="text-sm">
              {t('currentFolder')}
            </Label>
          </div>
          {invalid ? (
            <p role="alert" className="text-sm text-destructive">
              {t('invalidRange')}
            </p>
          ) : null}
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSearch({ ...EMPTY_SEARCH, q: search.q })}
            >
              {t('clear')}
            </Button>
            <Button type="button" onClick={() => submit()} disabled={invalid}>
              {t('apply')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </form>
  );
}
