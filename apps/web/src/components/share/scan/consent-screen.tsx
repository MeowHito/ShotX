'use client';

import { type ConsentPolicyVersion, ErrorCode } from '@shotx/shared';
import { Alert, Button, Checkbox, Label } from '@shotx/ui';
import { ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { isApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useGiveConsent, useInvalidateShare } from '@/lib/share/queries';

const POINTS = ['purpose', 'noStorage', 'results', 'processor', 'withdraw'] as const;

/**
 * The versioned Thai consent text (PDPA section 26), shown before any selfie is taken. The text
 * comes from `consent.policies[policyVersion]`; accepting posts that exact version.
 */
export function ConsentScreen({
  token,
  policyVersion,
  onAccepted,
  onDecline,
}: {
  token: string;
  policyVersion: ConsentPolicyVersion;
  onAccepted: () => void;
  onDecline: () => void;
}) {
  const t = useTranslations('consent');
  const describe = useErrorMessage();
  const checkboxId = useId();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const giveConsent = useGiveConsent(token);
  const invalidate = useInvalidateShare(token);

  async function accept() {
    if (!checked) {
      setError(t('mustCheck'));
      return;
    }
    setError(null);
    try {
      await giveConsent.mutateAsync(policyVersion);
      onAccepted();
    } catch (err) {
      // The text changed under us: reload the meta, which carries the current version.
      if (isApiError(err, ErrorCode.CONSENT_VERSION_MISMATCH)) void invalidate();
      setError(describe(err));
    }
  }

  return (
    <section aria-labelledby={`${checkboxId}-title`} className="space-y-4">
      <div className="flex items-start gap-3">
        <ShieldCheckIcon className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden />
        <div>
          <h2 id={`${checkboxId}-title`} className="text-lg font-semibold">
            {t(`policies.${policyVersion}.title`)}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('version', { version: policyVersion })}
          </p>
        </div>
      </div>
      <p className="text-sm">{t(`policies.${policyVersion}.intro`)}</p>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        {POINTS.map((point) => (
          <li key={point}>{t(`policies.${policyVersion}.points.${point}`)}</li>
        ))}
      </ul>
      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Checkbox
          id={checkboxId}
          checked={checked}
          onCheckedChange={(value) => setChecked(value === true)}
          className="mt-0.5 size-5"
        />
        <Label htmlFor={checkboxId} className="text-sm leading-relaxed font-normal">
          {t(`policies.${policyVersion}.checkbox`)}
        </Label>
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" onClick={() => void accept()} disabled={giveConsent.isPending}>
          {t('accept')}
        </Button>
        <Button size="lg" variant="ghost" onClick={onDecline}>
          {t('decline')}
        </Button>
      </div>
    </section>
  );
}
