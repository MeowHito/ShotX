'use client';

import type { ShareTargetType } from '@shotx/shared';
import { Alert, Dialog, DialogContent, DialogHeader, DialogTitle } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { copyToClipboardWhenReady } from '@/lib/studio/clipboard';
import { useCreateShare, useMe, useShares } from '@/lib/studio/queries';
import { ShareForm } from './share-form';
import { ShareRow } from './share-row';

export interface ShareTargetRef {
  type: ShareTargetType;
  id: string;
  name: string;
}

/**
 * Shares of one file or folder: the existing links and a form for a new one. Creating a link
 * copies it and closes the dialog (`onCreatedAndCopied`, owner request, ADR 0015); when the
 * browser refuses the copy the dialog stays open with the new link and its copy button.
 */
export function ShareDialog({
  target,
  onOpenChange,
  onCreatedAndCopied,
}: {
  target: ShareTargetRef | null;
  onOpenChange: (open: boolean) => void;
  onCreatedAndCopied?: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      {target !== null ? (
        <DialogContent
          closeLabel={t('common.close')}
          aria-describedby={undefined}
          className="max-h-[90dvh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{t('shareDialog.title', { name: target.name })}</DialogTitle>
          </DialogHeader>
          <ShareDialogBody target={target} onCreatedAndCopied={onCreatedAndCopied} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ShareDialogBody({
  target,
  onCreatedAndCopied,
}: {
  target: ShareTargetRef;
  onCreatedAndCopied?: () => void;
}) {
  const td = useTranslations('shareDialog');
  const me = useMe();
  const create = useCreateShare();
  const shares = useShares(
    target.type === 'folder' ? { folderId: target.id } : { fileId: target.id },
  );
  const [created, setCreated] = useState(false);

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h3 className="text-sm font-medium">{td('existing')}</h3>
        {shares.isPending ? null : shares.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td('none')}</p>
        ) : (
          shares.items.map((share) => <ShareRow key={share.id} share={share} showTarget={false} />)
        )}
      </section>
      <section className="grid gap-2">
        <h3 className="text-sm font-medium">{td('newLink')}</h3>
        {created ? <Alert role="status">{td('created')}</Alert> : null}
        <ShareForm
          kind="create"
          targetType={target.type}
          faceSearchEnabled={me.data?.features.faceSearch ?? false}
          onSubmit={async (settings) => {
            const creating = create.mutateAsync({
              target:
                target.type === 'folder'
                  ? { type: 'folder', folderId: target.id }
                  : { type: 'file', fileId: target.id },
              ...settings,
            });
            if (onCreatedAndCopied !== undefined) {
              // Started in the submit handler itself (before any await) so Safari allows it.
              const copying = copyToClipboardWhenReady(creating.then((share) => share.url));
              copying.catch(() => undefined); // awaited below, after `creating`
              await creating;
              try {
                await copying;
                onCreatedAndCopied();
                return;
              } catch {
                // The browser refused the copy: the new link is listed above with its copy button.
              }
            }
            await creating;
            setCreated(true);
          }}
        />
      </section>
    </div>
  );
}
