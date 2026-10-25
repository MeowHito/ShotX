'use client';

import { ErrorCode, type FaceSearchResponse, type ShareMetaResponse } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { SELFIE_ANGLES, type SelfieIssue } from '@/lib/face/quality-gate';
import { processSelfie, type SelfieSource } from '@/lib/face/selfie';
import { useFaceDeletion, useFaceSearch, useInvalidateShare } from '@/lib/share/queries';
import { ConsentScreen } from './consent-screen';
import { useFaceTools } from './face-tools';
import { SelfieCapture } from './selfie-capture';

export type ScanPurpose = 'search' | 'delete';

interface Selfie {
  blob: Blob;
  /** Object URL for the thumbnail; revoked as soon as the selfie is dropped. */
  url: string;
}

/**
 * Consent, then one to FACE_MAX_SELFIES selfies (front, slightly left, slightly right), each
 * checked by the client-side quality gate, then one multipart upload: face search ("search") or
 * the "delete my face" request ("delete"). Selfies live only in this component's memory and are dropped
 * after the request; nothing is written to storage or logged.
 */
export function ScanFlow({
  token,
  meta,
  purpose,
  onResults,
  onClose,
}: {
  token: string;
  meta: ShareMetaResponse;
  purpose: ScanPurpose;
  onResults?: (results: FaceSearchResponse) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const tools = useFaceTools();
  const invalidate = useInvalidateShare(token);
  const search = useFaceSearch(token);
  const deletion = useFaceDeletion(token);

  const [selfies, setSelfies] = useState<Selfie[]>([]);
  const [adding, setAdding] = useState(true);
  const [checking, setChecking] = useState(false);
  const [issue, setIssue] = useState<SelfieIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<number | null>(null);
  const selfiesRef = useRef(selfies);
  useEffect(() => {
    selfiesRef.current = selfies;
  }, [selfies]);

  // Drop every selfie (and its object URL) when the flow closes.
  useEffect(() => () => selfiesRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const maxAngles = Math.min(tools.config.maxSelfies, SELFIE_ANGLES.length);
  const angle = SELFIE_ANGLES[Math.min(selfies.length, SELFIE_ANGLES.length - 1)] ?? 'front';
  const policyVersion = meta.faceSearch.policyVersion;
  const busy = checking || search.isPending || deletion.isPending;

  function dropSelfies() {
    selfiesRef.current.forEach((s) => URL.revokeObjectURL(s.url));
    selfiesRef.current = [];
    setSelfies([]);
    setAdding(true);
  }

  async function onCaptured(source: SelfieSource) {
    setChecking(true);
    setIssue(null);
    setError(null);
    try {
      const result = await processSelfie(source, angle, tools);
      if (!result.ok) {
        setIssue(result.issue);
        return;
      }
      const selfie = { blob: result.blob, url: URL.createObjectURL(result.blob) };
      setSelfies((prev) => [...prev, selfie]);
      setAdding(false);
    } catch {
      setIssue('unreadable');
    } finally {
      setChecking(false);
    }
  }

  function removeSelfie(index: number) {
    const removed = selfies[index];
    if (removed !== undefined) URL.revokeObjectURL(removed.url);
    const next = selfies.filter((_, i) => i !== index);
    setSelfies(next);
    if (next.length === 0) setAdding(true);
  }

  async function submit() {
    setError(null);
    const blobs = selfies.map((s) => s.blob);
    try {
      if (purpose === 'search') {
        const results = await search.mutateAsync(blobs);
        dropSelfies();
        onResults?.(results);
      } else {
        const res = await deletion.mutateAsync(blobs);
        dropSelfies();
        setDeleted(res.facesMatched);
      }
    } catch (err) {
      if (
        isApiError(err, ErrorCode.CONSENT_REQUIRED) ||
        isApiError(err, ErrorCode.CONSENT_VERSION_MISMATCH)
      ) {
        // Consent is missing or stale: the meta refetch brings the consent screen back.
        void invalidate();
      }
      // The selfies were looked at by the server either way; never keep them for a retry
      // unless the request never got through.
      if (!(err instanceof Error && err.name === 'NetworkError')) dropSelfies();
      setError(describe(err));
    }
  }

  const title = purpose === 'search' ? t('capture.title') : t('faceDeletion.title');

  let body;
  if (!meta.faceSearch.consented && policyVersion !== null) {
    body = (
      <ConsentScreen
        token={token}
        policyVersion={policyVersion}
        onAccepted={() => setError(null)}
        onDecline={onClose}
      />
    );
  } else if (deleted !== null) {
    body = (
      <div className="space-y-3" role="status">
        <p className="font-medium">{t('faceDeletion.done', { count: deleted })}</p>
        {deleted > 0 ? (
          <p className="text-sm text-muted-foreground">{t('faceDeletion.doneNote')}</p>
        ) : null}
        <Button onClick={onClose}>{t('faceDeletion.close')}</Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {purpose === 'delete' ? <p className="text-sm">{t('faceDeletion.intro')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('capture.notStored')}</p>
        {selfies.length > 0 ? (
          <ul className="flex gap-2">
            {selfies.map((selfie, i) => (
              <li key={selfie.url} className="relative">
                {/* A blob: URL of the in-memory selfie; never uploaded anywhere but the API. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={selfie.url}
                  alt={t('capture.selfieAlt', { n: i + 1 })}
                  className="size-20 rounded-lg object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeSelfie(i)}
                  className="absolute -top-2 -right-2 rounded-full bg-background p-1 shadow"
                  aria-label={t('capture.remove')}
                  disabled={busy}
                >
                  <XIcon className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {adding ? (
          <>
            {maxAngles > 1 ? (
              <p className="text-sm text-muted-foreground">
                {t('capture.angleStep', {
                  current: selfies.length + 1,
                  max: maxAngles,
                  angle: t(`capture.angles.${angle}`),
                })}
              </p>
            ) : null}
            <SelfieCapture
              onCaptured={(s) => void onCaptured(s)}
              allowGallery={meta.mode === 'gallery'}
              busy={busy}
            />
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <Button size="lg" onClick={() => void submit()} disabled={busy}>
              {purpose === 'search'
                ? search.isPending
                  ? t('capture.searching')
                  : t('capture.search')
                : deletion.isPending
                  ? t('faceDeletion.submitting')
                  : t('faceDeletion.submit')}
            </Button>
            {selfies.length < maxAngles ? (
              <>
                <Button variant="outline" onClick={() => setAdding(true)} disabled={busy}>
                  {t('capture.addAngle', { angle: t(`capture.angles.${angle}`) })}
                </Button>
                <p className="text-xs text-muted-foreground">{t('capture.addAngleHint')}</p>
              </>
            ) : null}
          </div>
        )}
        {checking ? (
          <p role="status" className="text-sm">
            {t('capture.checking')}
          </p>
        ) : null}
        {issue !== null ? <Alert variant="warning">{t(`capture.issues.${issue}`)}</Alert> : null}
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border p-4" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('common.close')}>
          <XIcon aria-hidden />
        </Button>
      </div>
      {body}
    </section>
  );
}
