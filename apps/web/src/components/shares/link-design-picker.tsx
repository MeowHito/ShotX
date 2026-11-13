'use client';

import type { OwnerShare } from '@shotx/shared';
import { Alert } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useUpdateShare } from '@/lib/studio/queries';
import { DesignPicker } from './design-picker';

/**
 * The page design of one live link, changed in place (ADR 0019): the same URL shows the new
 * design right away (PATCH /shares/:id { designId }), so a published link never has to be
 * replaced to change its look.
 */
export function LinkDesignPicker({ share }: { share: OwnerShare }) {
  const td = useTranslations('shareDialog');
  const describe = useErrorMessage();
  const update = useUpdateShare();
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  return (
    <div className="grid gap-3">
      {notice !== null ? (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
          {notice.text}
        </Alert>
      ) : null}
      <DesignPicker
        value={share.designId}
        onChange={(designId) => {
          if (designId === share.designId || update.isPending) return;
          setNotice(null);
          update.mutate(
            { id: share.id, body: { designId } },
            {
              onSuccess: () => setNotice({ kind: 'info', text: td('designSaved') }),
              onError: (err) => setNotice({ kind: 'error', text: describe(err) }),
            },
          );
        }}
      />
    </div>
  );
}
