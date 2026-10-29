'use client';

import {
  type CaptchaAction,
  type ConsentPolicyVersion,
  ErrorCode,
  type FaceSearchResponse,
  rateLimitedDetailsSchema,
} from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api/errors';
import type { SelfieLimits } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { SELFIE_ANGLES, type SelfieIssue } from '@/lib/face/quality-gate';
import { processSelfie, type SelfieSource } from '@/lib/face/selfie';
import { useFaceDeletion, useFaceSearch, useInvalidateShare } from '@/lib/share/queries';
import { CaptchaChallenge, type CaptchaFailure } from './captcha-challenge';
import { ConsentScreen, knownPolicyVersion } from './consent-screen';
import { useFaceTools } from './face-tools';
import { SelfieCapture } from './selfie-capture';

export type ScanPurpose = 'search' | 'delete';

interface Selfie {
  blob: Blob;
  /** Object URL for the thumbnail; revoked as soon as the selfie is dropped. */
  url: string;
}

/** The consent state the API reported (share meta, or face-deletion info). */
export interface ScanConsent {
  /** The text version to show; null when the API offers none (face search unavailable). */
  policyVersion: ConsentPolicyVersion | null;
  consented: boolean;
  /** face_search only: how long results are kept (stated in the consent text). */
  resultTtlSeconds: number | null;
}

/**
 * Consent, then one to FACE_MAX_SELFIES selfies (front, slightly left, slightly right), each
 * checked by the client-side quality gate, then one multipart upload: face search ("search") or
 * the "delete my face" request ("delete"). The selfie limits come from the API (`limits`), the
 * gate from the web config. Selfies live only in this component's memory and are dropped after
 * the request; nothing is written to storage or logged.
 *
 * A scan answered with CONSENT_REQUIRED or CONSENT_VERSION_MISMATCH brings the consent screen
 * back with the version from the error details.
 *
 * Over a rate limit the API answers RATE_LIMITED before it reads any selfie. When its details
 * offer a Turnstile challenge (`captcha`, not `unavailable`), the selfies stay in memory, the
 * widget is shown (its script loads only now) and the same selfies are sent again with the token;
 * an expired or invalid token shows why and a fresh widget. Otherwise only waiting helps: the
 * wait message is shown and the selfies are dropped.
 */
export function ScanFlow({
  token,
  purpose,
  consent,
  limits,
  allowGallery,
  onResults,
  onClose,
}: {
  token: string;
  purpose: ScanPurpose;
  consent: ScanConsent;
  limits: SelfieLimits;
  allowGallery: boolean;
  onResults?: (results: FaceSearchResponse) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const tools = useFaceTools();
  const invalidate = useInvalidateShare(token);
  const search = useFaceSearch(token);
  const deletion = useFaceDeletion(token);

  const [consentNeeded, setConsentNeeded] = useState(!consent.consented);
  const [consentVersion, setConsentVersion] = useState(consent.policyVersion);
  const [selfies, setSelfies] = useState<Selfie[]>([]);
  const [adding, setAdding] = useState(true);
  const [checking, setChecking] = useState(false);
  const [issue, setIssue] = useState<SelfieIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<number | null>(null);
  /** A Turnstile challenge the API asked for; `attempt` remounts the widget for a fresh token. */
  const [challenge, setChallenge] = useState<{
    action: CaptchaAction;
    attempt: number;
    failed: boolean;
  } | null>(null);
  const captcha = tools.config.captcha;
  const selfiesRef = useRef(selfies);
  useEffect(() => {
    selfiesRef.current = selfies;
  }, [selfies]);

  // Drop every selfie (and its object URL) when the flow closes.
  useEffect(() => () => selfiesRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const processor = useMemo(
    () => ({
      canvas: tools.canvas,
      loadDetector: tools.loadDetector,
      config: { gate: tools.config.gate, selfie: limits.selfie },
    }),
    [tools, limits.selfie],
  );
  const maxAngles = Math.min(limits.maxSelfies, SELFIE_ANGLES.length);
  const angle = SELFIE_ANGLES[Math.min(selfies.length, SELFIE_ANGLES.length - 1)] ?? 'front';
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
      const result = await processSelfie(source, angle, processor);
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

  /** The Turnstile action the API offers for this error, or null when only waiting helps. */
  function challengeFor(err: unknown): CaptchaAction | null {
    if (!isApiError(err, ErrorCode.RATE_LIMITED)) return null;
    const details = rateLimitedDetailsSchema.safeParse(err.details);
    const offered = details.success ? details.data.captcha : null;
    if (offered === null || offered.rejected === 'unavailable') return null;
    if (captcha.provider !== 'turnstile' || tools.loadTurnstile === null) return null;
    return offered.action;
  }

  /**
   * A RATE_LIMITED this flow can't answer with a challenge, described as "wait": the API may
   * offer one that web isn't set up for (another CAPTCHA_PROVIDER here).
   */
  function waitOnly(err: unknown): unknown {
    if (!isApiError(err, ErrorCode.RATE_LIMITED)) return err;
    const details = rateLimitedDetailsSchema.safeParse(err.details);
    if (!details.success) return err;
    return new ApiError(err.status, err.code, err.message, { ...details.data, captcha: null });
  }

  async function submit(captchaToken?: string) {
    setError(null);
    const blobs = selfies.map((s) => s.blob);
    try {
      if (purpose === 'search') {
        const results = await search.mutateAsync({ selfies: blobs, captchaToken });
        setChallenge(null);
        dropSelfies();
        onResults?.(results);
      } else {
        const res = await deletion.mutateAsync({ selfies: blobs, captchaToken });
        setChallenge(null);
        dropSelfies();
        setDeleted(res.facesMatched);
      }
    } catch (err) {
      const action = challengeFor(err);
      if (action !== null) {
        // The API refused before reading the selfies: keep them (in memory) for the retry.
        setChallenge((prev) => ({ action, attempt: (prev?.attempt ?? 0) + 1, failed: false }));
        setError(describe(err));
        return;
      }
      setChallenge(null);
      // The selfies were looked at by the server either way; never keep them for a retry
      // unless the request never got through.
      if (!(err instanceof Error && err.name === 'NetworkError')) dropSelfies();
      if (
        isApiError(err, ErrorCode.CONSENT_REQUIRED) ||
        isApiError(err, ErrorCode.CONSENT_VERSION_MISMATCH)
      ) {
        // Consent is missing or stale: show the current text and ask again.
        const current = knownPolicyVersion(err.details);
        void invalidate();
        if (current !== null) {
          setConsentVersion(current);
          setConsentNeeded(true);
        } else {
          setError(t('errors.client.consentVersionUnknown'));
          return;
        }
      }
      setError(describe(waitOnly(err)));
    }
  }

  function onCaptchaFailure(failure: CaptchaFailure) {
    if (failure === 'expired') {
      // The challenge timed out before a token: a fresh widget.
      setError(t('errors.details.captchaExpired'));
      setChallenge((prev) => (prev === null ? null : { ...prev, attempt: prev.attempt + 1 }));
    } else {
      setError(t('errors.client.captchaUnavailable'));
      setChallenge((prev) => (prev === null ? null : { ...prev, failed: true }));
    }
  }

  const title = purpose === 'search' ? t('capture.title') : t('faceDeletion.title');

  let body;
  if (consentNeeded && consentVersion !== null) {
    body = (
      <div className="space-y-4">
        {error !== null ? <Alert variant="warning">{error}</Alert> : null}
        <ConsentScreen
          key={consentVersion}
          token={token}
          purpose={purpose === 'search' ? 'face_search' : 'face_deletion'}
          policyVersion={consentVersion}
          resultTtlSeconds={consent.resultTtlSeconds}
          onAccepted={(version) => {
            setConsentVersion(version);
            setConsentNeeded(false);
            setError(null);
          }}
          onDecline={onClose}
        />
      </div>
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
        {challenge !== null && captcha.provider === 'turnstile' && tools.loadTurnstile !== null ? (
          <div className="space-y-3">
            {error !== null ? <Alert variant="warning">{error}</Alert> : null}
            {busy ? (
              <p role="status" className="text-sm">
                {t('capture.captchaVerifying')}
              </p>
            ) : challenge.failed ? (
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setChallenge({ ...challenge, attempt: challenge.attempt + 1, failed: false });
                }}
              >
                {t('capture.captchaRetry')}
              </Button>
            ) : (
              <CaptchaChallenge
                key={challenge.attempt}
                loader={tools.loadTurnstile}
                siteKey={captcha.siteKey}
                action={challenge.action}
                onToken={(token) => void submit(token)}
                onFailure={onCaptchaFailure}
              />
            )}
          </div>
        ) : adding ? (
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
              allowGallery={allowGallery}
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
        {error !== null && challenge === null ? <Alert variant="destructive">{error}</Alert> : null}
      </div>
    );
  }

  return (
    <section
      className="animate-pop-in space-y-4 rounded-2xl border bg-background p-5 shadow-card sm:p-6"
      aria-label={title}
    >
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
