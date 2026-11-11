'use client';

import {
  CONSENT_POLICY_VERSIONS,
  type ConsentPolicyVersion,
  type ConsentPurpose,
  consentVersionDetailsSchema,
  ErrorCode,
} from '@shotx/shared';
import { Alert, Button, Checkbox, Label } from '@shotx/ui';
import { ShieldCheckIcon } from 'lucide-react';
import { useMessages, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { isApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useGiveConsent } from '@/lib/share/queries';

/** Display order of a policy's points; a version shows those it has (`transfer` from 2026-11-11). */
const POINTS = ['purpose', 'noStorage', 'results', 'processor', 'transfer', 'withdraw'] as const;

/** A version string the API sent, if this build has its text. */
export function knownPolicyVersion(value: unknown): ConsentPolicyVersion | null {
  const parsed = consentVersionDetailsSchema.safeParse(value);
  if (!parsed.success) return null;
  return (CONSENT_POLICY_VERSIONS as readonly string[]).includes(parsed.data.policyVersion)
    ? (parsed.data.policyVersion as ConsentPolicyVersion)
    : null;
}

/** A TTL in seconds as Thai text: whole hours, else minutes (rounded up). */
export function useDurationText(): (seconds: number) => string {
  const td = useTranslations('common.duration');
  return (seconds) =>
    seconds % 3600 === 0
      ? td('hours', { count: seconds / 3600 })
      : td('minutes', { count: Math.ceil(seconds / 60) });
}

/**
 * The versioned Thai consent text of one purpose (PDPA section 26), shown before any selfie is
 * taken. The text comes from `consent.policies[purpose][version]`; accepting posts that exact
 * version and purpose. The face-search text states the API's result TTL (share meta).
 *
 * CONSENT_VERSION_MISMATCH (the text changed after the page loaded): the screen switches to the
 * current version from the error details, clears the checkbox and asks again. A version this
 * build has no text for can't be shown, so the person is asked to reload.
 */
export function ConsentScreen({
  token,
  purpose,
  policyVersion,
  resultTtlSeconds,
  onAccepted,
  onDecline,
}: {
  token: string;
  purpose: ConsentPurpose;
  policyVersion: ConsentPolicyVersion;
  /** face_search: SHARE_FACE_ONLY_GRANT_TTL_SECONDS from share meta. */
  resultTtlSeconds: number | null;
  onAccepted: (version: ConsentPolicyVersion) => void;
  onDecline: () => void;
}) {
  const t = useTranslations('consent');
  const messages = useMessages();
  const tc = useTranslations('errors.client');
  const describe = useErrorMessage();
  const duration = useDurationText();
  const checkboxId = useId();
  const [version, setVersion] = useState<ConsentPolicyVersion>(policyVersion);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const giveConsent = useGiveConsent(token, purpose);

  async function accept() {
    if (!checked) {
      setError(t('mustCheck'));
      return;
    }
    setError(null);
    try {
      await giveConsent.mutateAsync(version);
      onAccepted(version);
    } catch (err) {
      if (isApiError(err, ErrorCode.CONSENT_VERSION_MISMATCH)) {
        const current = knownPolicyVersion(err.details);
        setChecked(false);
        if (current === null) {
          setBlocked(true);
          setError(tc('consentVersionUnknown'));
        } else {
          // Show the current text and ask again.
          setVersion(current);
          setError(describe(err));
        }
        return;
      }
      setError(describe(err));
    }
  }

  const values = { ttl: resultTtlSeconds === null ? '' : duration(resultTtlSeconds) };
  const key = `policies.${purpose}.${version}` as const;
  const policyPoints = messages.consent.policies[purpose][version].points;
  const points = POINTS.filter((point) => point in policyPoints);

  return (
    <section aria-labelledby={`${checkboxId}-title`} className="space-y-4">
      <div className="flex items-start gap-3">
        <ShieldCheckIcon className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden />
        <div>
          <h2 id={`${checkboxId}-title`} className="text-lg font-semibold">
            {t(`${key}.title`)}
          </h2>
          <p className="text-xs text-muted-foreground">{t('version', { version })}</p>
        </div>
      </div>
      <p className="text-sm">{t(`${key}.intro`)}</p>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        {points.map((point) => (
          // Not every version has every point (checked above); th.test formats each one.
          <li key={point}>
            {t(`${key}.points.${point}` as `${typeof key}.points.results`, values)}
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-3 rounded-xl border bg-sidebar p-4">
        <Checkbox
          id={checkboxId}
          checked={checked}
          onCheckedChange={(value) => setChecked(value === true)}
          className="mt-0.5 size-5"
          disabled={blocked}
        />
        <Label htmlFor={checkboxId} className="text-sm leading-relaxed font-normal">
          {t(`${key}.checkbox`)}
        </Label>
      </div>
      {error !== null ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" onClick={() => void accept()} disabled={giveConsent.isPending || blocked}>
          {purpose === 'face_deletion' ? t('acceptDeletion') : t('accept')}
        </Button>
        <Button size="lg" variant="ghost" onClick={onDecline}>
          {t('decline')}
        </Button>
      </div>
    </section>
  );
}
