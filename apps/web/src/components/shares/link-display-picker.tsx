'use client';

import { isDisplayDesign, type OwnerShare } from '@shotx/shared';
import { Alert, Button, cn } from '@shotx/ui';
import { ExternalLinkIcon, MonitorIcon, PaletteIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { DesignPreview } from '@/components/design/design-preview';
import { DESIGNS_HREF } from '@/components/drive/paths';
import { assetUrls, useDesigns } from '@/lib/design/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useUpdateShare } from '@/lib/studio/queries';

const PREVIEW_WIDTH = 48;

/** ADR 0033: the event screen of a link: its URL plus `/display`. */
export function displayUrlOf(shareUrl: string): string {
  return `${shareUrl.replace(/\/+$/, '')}/display`;
}

/**
 * ADR 0033: the event screen of one live link: open it (a new tab, for the screen at the event)
 * and choose its design in place (PATCH /shares/:id { displayDesignId }): one of the owner's
 * display designs, or "automatic" (null: the built-in screen on the share page design's
 * background). Scanning the screen's QR opens the link's share page with its own design.
 */
export function LinkDisplayPicker({ share }: { share: OwnerShare }) {
  const t = useTranslations('displayPicker');
  const describe = useErrorMessage();
  const update = useUpdateShare();
  const designs = useDesigns();
  const id = useId();
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const items = useMemo(
    () => (designs.data?.items ?? []).filter((d) => isDisplayDesign(d.doc)),
    [designs.data],
  );
  const assets = useMemo(() => assetUrls(designs.data?.assets ?? {}), [designs.data]);

  function choose(displayDesignId: string | null) {
    if (displayDesignId === share.displayDesignId || update.isPending) return;
    setNotice(null);
    update.mutate(
      { id: share.id, body: { displayDesignId } },
      {
        onSuccess: () => setNotice({ kind: 'info', text: t('saved') }),
        onError: (err) => setNotice({ kind: 'error', text: describe(err) }),
      },
    );
  }

  const option = (key: string, value: string | null, label: string, preview: ReactNode) => {
    const checked = share.displayDesignId === value;
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
          name={`${id}-display`}
          checked={checked}
          onChange={() => choose(value)}
          className="size-4 shrink-0"
        />
        <span
          className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted"
          style={{ width: PREVIEW_WIDTH, height: (PREVIEW_WIDTH * 844) / 390 }}
          aria-hidden
        >
          {preview}
        </span>
        <span className="min-w-0 truncate font-medium">{label}</span>
      </label>
    );
  };

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a href={displayUrlOf(share.url)} target="_blank" rel="noreferrer">
            <MonitorIcon aria-hidden />
            {t('open')}
            <ExternalLinkIcon aria-hidden />
          </a>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={DESIGNS_HREF}>
            <PaletteIcon aria-hidden />
            {t('manage')}
          </Link>
        </Button>
      </div>
      {notice !== null ? (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
          {notice.text}
        </Alert>
      ) : null}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('design')}</legend>
        <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
          {option(
            'auto',
            null,
            t('auto'),
            <MonitorIcon className="size-5 text-muted-foreground" />,
          )}
          {items.map((d) =>
            option(
              d.id,
              d.id,
              d.name,
              <DesignPreview doc={d.doc} assets={assets} width={PREVIEW_WIDTH} />,
            ),
          )}
        </div>
        {designs.data !== undefined && items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('empty')}</p>
        ) : null}
      </fieldset>
    </div>
  );
}
