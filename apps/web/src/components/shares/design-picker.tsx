'use client';

import { designShowsPhotos, isDisplayDesign } from '@shotx/shared';
import { Button, cn } from '@shotx/ui';
import { PaletteIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useId, useMemo, useRef } from 'react';
import { DesignPreview } from '@/components/design/design-preview';
import { DESIGNS_HREF } from '@/components/drive/paths';
import { assetUrls, useDesigns } from '@/lib/design/queries';

const PREVIEW_WIDTH = 56;

/**
 * The share form's share page picker (ADR 0013): one of the owner's designs, each with a small
 * live preview, or "no design" (designId null: the plain layout). The default design is badged
 * and listed first; "manage designs" is a button (ADR 0028).
 * A new share starts on the default design (`preselectDefault`), once, when the list arrives;
 * setting a default later never changes existing shares.
 */
export function DesignPicker({
  value,
  onChange,
  preselectDefault = false,
}: {
  value: string | null;
  onChange: (designId: string | null) => void;
  preselectDefault?: boolean;
}) {
  const t = useTranslations('shareForm');
  const id = useId();
  const designs = useDesigns();
  // The default design comes first, ahead of "no design" (owner, 2026-11-16, ADR 0028).
  const items = useMemo(() => {
    // ADR 0033: event screens are chosen on their own (DisplayDesignPicker).
    const list = (designs.data?.items ?? []).filter((d) => !isDisplayDesign(d.doc));
    return [...list.filter((d) => d.isDefault), ...list.filter((d) => !d.isDefault)];
  }, [designs.data]);
  const assets = useMemo(() => assetUrls(designs.data?.assets ?? {}), [designs.data]);
  const fallback = items.find((d) => d.isDefault) ?? null;
  const preselected = useRef(!preselectDefault);
  const defaultId = fallback?.id ?? null;
  useEffect(() => {
    if (preselected.current || designs.data === undefined) return;
    preselected.current = true;
    if (value === null && defaultId !== null) onChange(defaultId);
  }, [designs.data, value, defaultId, onChange]);

  const option = (
    key: string,
    designId: string | null,
    label: string,
    sub: ReactNode,
    preview: ReactNode,
  ) => {
    const checked = value === designId;
    return (
      <label
        key={key}
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-sm transition-colors',
          checked ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent/60',
        )}
      >
        <input
          type="radio"
          name={`${id}-design`}
          checked={checked}
          onChange={() => onChange(designId)}
          className="size-4 shrink-0"
        />
        <span
          className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted"
          style={{ width: PREVIEW_WIDTH, height: (PREVIEW_WIDTH * 844) / 390 }}
          aria-hidden
        >
          {preview}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate font-medium">{label}</span>
          {sub}
        </span>
      </label>
    );
  };

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{t('design')}</legend>
      <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2">
        {items.map((d) =>
          option(
            d.id,
            d.id,
            d.name,
            d.isDefault || !designShowsPhotos(d.doc) ? (
              <span className="text-xs text-muted-foreground">
                {[
                  d.isDefault ? t('designIsDefault') : null,
                  designShowsPhotos(d.doc) ? null : t('designHidesPhotos'),
                ]
                  .filter((x) => x !== null)
                  .join(' · ')}
              </span>
            ) : null,
            <DesignPreview doc={d.doc} assets={assets} width={PREVIEW_WIDTH} />,
          ),
        )}
        {option(
          'none',
          null,
          t('designNone'),
          <span className="text-xs text-muted-foreground">{t('designNoneHint')}</span>,
          null,
        )}
      </div>
      {designs.isError ? <p className="text-xs text-destructive">{t('designLoadError')}</p> : null}
      {designs.data !== undefined && items.length === 0 ? (
        // No designs yet: straight to the designer (owner, 2026-11-13).
        <div className="grid justify-items-start gap-2 rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">{t('designEmpty')}</p>
          <Button asChild size="sm" variant="outline">
            <Link href={DESIGNS_HREF}>
              <PaletteIcon aria-hidden />
              {t('designCreate')}
            </Link>
          </Button>
        </div>
      ) : (
        <Button asChild size="sm" variant="outline" className="justify-self-start">
          <Link href={DESIGNS_HREF}>
            <PaletteIcon aria-hidden />
            {t('designManage')}
          </Link>
        </Button>
      )}
    </fieldset>
  );
}
