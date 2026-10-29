'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { SHORTCUT_IDS, shortcutKeys } from '@/lib/studio/shortcuts';

/** Every studio shortcut for this platform (opened with `?`, ⌘/ or Ctrl+/, or the account menu). */
export function ShortcutsDialog({
  open,
  onOpenChange,
  apple,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apple: boolean;
}) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <dl className="divide-y">
          {SHORTCUT_IDS.map((id) => (
            <div key={id} className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-sm">{t(`shortcuts.items.${id}`)}</dt>
              <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-xs">
                {shortcutKeys(id, apple).map((key, i) => (
                  <Fragment key={key}>
                    {i > 0 ? (
                      <span className="text-muted-foreground">{t('shortcuts.or')}</span>
                    ) : null}
                    <kbd className="rounded-md border bg-muted px-1.5 py-0.5 font-sans font-medium">
                      {key}
                    </kbd>
                  </Fragment>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
