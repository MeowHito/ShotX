'use client';

import { DESIGN_ARTBOARD, type DesignDoc, SHARE_MODES, type ShareMode } from '@shotx/shared';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shotx/ui';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { useState } from 'react';
import { type Locale, LOCALES, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { DESIGN_SHORTCUTS } from '@/lib/design/shortcuts';
import { DesignCanvas, type DesignCanvasAssets } from '../design-canvas';
import { SelectField } from './fields';

const PREVIEW_WIDTH = 320;

/**
 * "Preview as viewer": the design as a viewer sees it, in th/en/zh (the button labels change) and as a
 * gallery or face_only link (the choose-a-photo button).
 */
export function PreviewDialog({
  open,
  onOpenChange,
  doc,
  assets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DesignDoc;
  assets: DesignCanvasAssets;
}) {
  const t = useTranslations('designs.editor.previewDialog');
  const tc = useTranslations('common');
  const tl = useTranslations('publicNav.locales');
  const [locale, setLocale] = useState<Locale>('th');
  const [mode, setMode] = useState<ShareMode>('gallery');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          closeLabel={tc('close')}
          aria-describedby={undefined}
          className="max-h-[95dvh] overflow-y-auto sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label={t('language')}
              value={locale}
              options={LOCALES.map((l) => ({ value: l, label: tl(l) }))}
              onChange={setLocale}
            />
            <SelectField
              label={t('mode')}
              value={mode}
              options={SHARE_MODES.map((m) => ({ value: m, label: t(`modes.${m}`) }))}
              onChange={setMode}
            />
          </div>
          <div
            className="mx-auto overflow-hidden rounded-2xl border shadow-card"
            style={{ width: PREVIEW_WIDTH }}
            data-testid="design-preview-frame"
            lang={locale}
          >
            <NextIntlClientProvider
              locale={locale}
              messages={MESSAGES[locale]}
              timeZone={TIME_ZONE}
            >
              <DesignCanvas
                doc={doc}
                assets={assets}
                mode={mode}
                layout={{ kind: 'artboard', unit: PREVIEW_WIDTH / DESIGN_ARTBOARD.width }}
              />
            </NextIntlClientProvider>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** The "?" dialog: every designer shortcut with this platform's keys. */
export function DesignShortcutsDialog({
  open,
  onOpenChange,
  apple,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apple: boolean;
}) {
  const tk = useTranslations('designs.editor.shortcutsDialog');
  const tc = useTranslations('common');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent closeLabel={tc('close')} className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tk('title')}</DialogTitle>
            <DialogDescription>{tk('note')}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            {DESIGN_SHORTCUTS.map((s) => (
              <div key={s.id} className="contents">
                <dt>{tk(`items.${s.id}`)}</dt>
                <dd className="flex flex-wrap justify-end gap-1">
                  {(apple ? s.apple : s.other).map((k) => (
                    <kbd
                      key={k}
                      className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs"
                    >
                      {k}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
