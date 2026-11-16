'use client';

import { Button, Sheet, SheetContent, SheetTitle } from '@shotx/ui';
import { useTranslations } from 'next-intl';

/**
 * The "how it works" sheet (ADR 0013, share.design.help): a short how-to as a bottom sheet. Every
 * share offers both the camera and "use a photo" (ADR 0028).
 */
export function HowToSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('share.design.howTo');
  const tc = useTranslations('common');
  const steps = [t('camera'), t('choosePhoto'), t('photo'), t('results')];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        closeLabel={tc('close')}
        aria-describedby={undefined}
        className="mx-auto max-w-lg"
      >
        <SheetTitle className="pr-10 text-lg font-semibold">{t('title')}</SheetTitle>
        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li key={step} className="flex gap-3 text-sm leading-relaxed">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                aria-hidden
              >
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <Button className="w-full rounded-full" size="lg" onClick={() => onOpenChange(false)}>
          {t('close')}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
