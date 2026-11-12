'use client';

import {
  type CaptchaAction,
  type ConsentPolicyVersion,
  ErrorCode,
  type FaceSearchResponse,
  rateLimitedDetailsSchema,
} from '@shotx/shared';
import { Alert, Button, Progress } from '@shotx/ui';
import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api/errors';
import type { SelfieLimits } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import type { SelfieIssue } from '@/lib/face/quality-gate';
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
 * Consent first (unchanged rule), then the camera (ADR 0011): one selfie in a round frame, checked
 * by the client-side quality gate without upfront tips (a failed check says why and the camera
 * comes back), and for face search the search starts as soon as the photo passes: no extra
 * angles, no second button, a progress bar while it runs. "Delete my face" ("delete", reached
 * only by its unlinked URL) keeps an explicit confirm button, since deletion can't be undone.
 * The selfie lives only in this component's memory and is dropped after the request; nothing is
 * written to storage or logged.
 *
 * A scan answered with CONSENT_REQUIRED or CONSENT_VERSION_MISMATCH brings the consent screen
 * back with the version from the error details.
 *
 * Over a rate limit the API answers RATE_LIMITED before it reads any selfie. When its details
 * offer a Turnstile challenge (`captcha`, not `unavailable`), the selfie stays in memory, the
 * widget is shown (its script loads only now) and the same selfie is sent again with the token;
 * an expired or invalid token shows why and a fresh widget. Otherwise only waiting helps: the
 * wait message is shown and the selfie is dropped.
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
  /** The selfie that passed the gate, kept only for a captcha retry or the delete confirm. */
  const [selfie, setSelfie] = useState<Selfie | null>(null);
  /** Remounts the camera for another photo. */
  const [attempt, setAttempt] = useState(0);
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
  const selfieRef = useRef(selfie);
  useEffect(() => {
    selfieRef.current = selfie;
  }, [selfie]);

  // Drop the selfie (and its object URL) when the flow closes.
  useEffect(
    () => () => {
      if (selfieRef.current !== null) URL.revokeObjectURL(selfieRef.current.url);
    },
    [],
  );

  const processor = useMemo(
    () => ({
      canvas: tools.canvas,
      loadDetector: tools.loadDetector,
      config: { gate: tools.config.gate, selfie: limits.selfie },
    }),
    [tools, limits.selfie],
  );
  const searching = search.isPending || deletion.isPending;
  const busy = checking || searching;

  function dropSelfie() {
    if (selfieRef.current !== null) URL.revokeObjectURL(selfieRef.current.url);
    selfieRef.current = null;
    setSelfie(null);
  }

  /** Back to the camera for another photo. */
  function retake() {
    dropSelfie();
    setAttempt((a) => a + 1);
  }

  async function onCaptured(source: SelfieSource) {
    setChecking(true);
    setIssue(null);
    setError(null);
    let captured: Selfie;
    try {
      const result = await processSelfie(source, 'front', processor);
      if (!result.ok) {
        setIssue(result.issue);
        setAttempt((a) => a + 1);
        return;
      }
      captured = { blob: result.blob, url: URL.createObjectURL(result.blob) };
    } catch {
      setIssue('unreadable');
      setAttempt((a) => a + 1);
      return;
    } finally {
      setChecking(false);
    }
    selfieRef.current = captured;
    setSelfie(captured);
    // Face search starts right away; deletion waits for its confirm button.
    if (purpose === 'search') await submit(undefined, captured);
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

  async function submit(captchaToken?: string, current: Selfie | null = selfieRef.current) {
    if (current === null) return;
    setError(null);
    const blobs = [current.blob];
    try {
      if (purpose === 'search') {
        const results = await search.mutateAsync({ selfies: blobs, captchaToken });
        setChallenge(null);
        dropSelfie();
        onResults?.(results);
      } else {
        const res = await deletion.mutateAsync({ selfies: blobs, captchaToken });
        setChallenge(null);
        dropSelfie();
        setDeleted(res.facesMatched);
      }
    } catch (err) {
      const action = challengeFor(err);
      if (action !== null) {
        // The API refused before reading the selfie: keep it (in memory) for the retry.
        setChallenge((prev) => ({ action, attempt: (prev?.attempt ?? 0) + 1, failed: false }));
        setError(describe(err));
        return;
      }
      setChallenge(null);
      // The selfie was looked at by the server either way; never keep it for a retry.
      dropSelfie();
      setAttempt((a) => a + 1);
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
  } else if (
    challenge !== null &&
    captcha.provider === 'turnstile' &&
    tools.loadTurnstile !== null
  ) {
    body = (
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
            onToken={(captchaToken) => void submit(captchaToken)}
            onFailure={onCaptchaFailure}
          />
        )}
      </div>
    );
  } else if (busy) {
    const label = checking
      ? t('capture.checking')
      : purpose === 'search'
        ? t('capture.searching')
        : t('faceDeletion.submitting');
    body = <SearchProgress label={label} />;
  } else if (purpose === 'delete' && selfie !== null) {
    body = (
      <div className="space-y-4">
        <p className="text-sm">{t('faceDeletion.intro')}</p>
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={() => void submit()}>
            {t('faceDeletion.submit')}
          </Button>
          <Button variant="outline" onClick={retake}>
            {t('capture.retake')}
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {purpose === 'delete' ? <p className="text-sm">{t('faceDeletion.intro')}</p> : null}
        {issue !== null ? <Alert variant="warning">{t(`capture.issues.${issue}`)}</Alert> : null}
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
        <SelfieCapture
          key={attempt}
          onCaptured={(s) => void onCaptured(s)}
          allowGallery={allowGallery}
          busy={busy}
        />
        <p className="text-center text-xs text-muted-foreground">{t('capture.notStored')}</p>
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

/**
 * The bar shown while the photo is checked and searched. The API gives no progress, so it moves
 * quickly at first and slows down towards 90% until the answer arrives.
 */
export function SearchProgress({ label }: { label: string }) {
  const [value, setValue] = useState(8);
  useEffect(() => {
    const timer = setInterval(() => setValue((v) => v + (90 - v) * 0.12), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="space-y-3 py-6 text-center" role="status">
      <p className="font-medium">{label}</p>
      <Progress value={value} aria-label={label} className="h-2.5" />
    </div>
  );
}
