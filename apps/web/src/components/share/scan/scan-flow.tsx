'use client';

import {
  type CaptchaAction,
  type ConsentPolicyVersion,
  ErrorCode,
  type FaceSearchResponse,
  isSupportedLocale,
  rateLimitedDetailsSchema,
} from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { XIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api/errors';
import type { SelfieLimits } from '@/lib/face/config';
import { nonBlockingDetectorLoader } from '@/lib/face/detector';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import type { SelfieIssue } from '@/lib/face/quality-gate';
import { processSelfie, type SelfieSource } from '@/lib/face/selfie';
import {
  useFaceDeletion,
  useFaceSearch,
  useGiveConsent,
  useInvalidateShare,
} from '@/lib/share/queries';
import { CaptchaChallenge, type CaptchaFailure } from './captcha-challenge';
import { ConsentScreen, knownPolicyVersion } from './consent-screen';
import { useFaceTools } from './face-tools';
import { SelfieCapture } from './selfie-capture';
import catDig from './assets/cat-dig.webp';

/** Next gives a static image import as `{ src }`, Vitest as the URL itself. */
const CAT_DIG_URL: string = typeof catDig === 'string' ? catDig : catDig.src;

export type ScanPurpose = 'search' | 'delete';

/**
 * What the capture step opens with: the live camera (default), or the gallery picker (the
 * designed card's "use a photo" button, ADR 0013; gallery-mode shares only).
 */
export type ScanSource = 'camera' | 'gallery';

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
 * Consent first (unchanged rule), then the camera (ADR 0011). Face search records the consent
 * itself as soon as the sheet opens (ADR 0015: the organiser tells attendees before the event, and
 * tapping "search by face" is the act of consent), so the camera comes up with no text to read;
 * "delete my face" keeps its consent screen: one selfie in a round frame, checked
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
  startWith = 'camera',
  photo,
  onResults,
  onClose,
}: {
  token: string;
  purpose: ScanPurpose;
  consent: ScanConsent;
  limits: SelfieLimits;
  allowGallery: boolean;
  startWith?: ScanSource;
  /**
   * A photo already picked (the designed card's "use a photo" button opens the picker itself):
   * checked and searched as soon as consent is recorded, as if picked in the sheet.
   */
  photo?: Blob;
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

  // The on-phone face check never holds the photo back: it starts downloading now, while the
  // camera opens, and a photo taken before it is in goes straight to the API.
  const loadDetector = useMemo(() => nonBlockingDetectorLoader(tools.loadDetector), [tools]);
  useEffect(() => {
    void loadDetector();
  }, [loadDetector]);

  const processor = useMemo(
    () => ({
      canvas: tools.canvas,
      loadDetector,
      config: { gate: tools.config.gate, selfie: limits.selfie },
    }),
    [tools, loadDetector, limits.selfie],
  );
  // The photo handed in is used once (also under Strict Mode's double effects), after consent.
  const pickedRef = useRef(photo ?? null);
  useEffect(() => {
    const picked = pickedRef.current;
    if (consentNeeded || picked === null) return;
    pickedRef.current = null;
    void onCaptured({ kind: 'file', blob: picked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentNeeded]);

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
  if (consentNeeded && consentVersion !== null && purpose === 'search') {
    body = (
      <AutoConsent
        key={consentVersion}
        token={token}
        policyVersion={consentVersion}
        onAccepted={(version) => {
          setConsentVersion(version);
          setConsentNeeded(false);
          setError(null);
        }}
      />
    );
  } else if (consentNeeded && consentVersion !== null) {
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
          startWith={startWith}
          busy={busy}
        />
        {purpose === 'delete' ? (
          <p className="text-center text-xs text-muted-foreground">{t('capture.notStored')}</p>
        ) : null}
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
 * Face search consent without a screen (ADR 0015): posts the face_search consent of
 * `policyVersion` once, as the person tapped the scan button, then hands over to the camera. A
 * newer version (CONSENT_VERSION_MISMATCH) is posted instead; any other error shows a retry.
 */
function AutoConsent({
  token,
  policyVersion,
  onAccepted,
}: {
  token: string;
  policyVersion: ConsentPolicyVersion;
  onAccepted: (version: ConsentPolicyVersion) => void;
}) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const locale = useLocale();
  const giveConsent = useGiveConsent(
    token,
    'face_search',
    isSupportedLocale(locale) ? locale : 'th',
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onAcceptedRef = useRef(onAccepted);
  useEffect(() => {
    onAcceptedRef.current = onAccepted;
  }, [onAccepted]);
  const { mutateAsync } = giveConsent;

  useEffect(() => {
    let live = true;
    async function post(version: ConsentPolicyVersion, retried: boolean): Promise<void> {
      try {
        await mutateAsync(version);
        if (live) onAcceptedRef.current(version);
      } catch (err) {
        if (!live) return;
        const current = isApiError(err, ErrorCode.CONSENT_VERSION_MISMATCH)
          ? knownPolicyVersion(err.details)
          : null;
        if (current !== null && !retried) return post(current, true);
        setError(
          isApiError(err, ErrorCode.CONSENT_VERSION_MISMATCH) && current === null
            ? t('errors.client.consentVersionUnknown')
            : describe(err),
        );
      }
    }
    void post(policyVersion, false);
    return () => {
      live = false;
    };
    // `attempt` re-runs the post after an error; t and describe are stable enough per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyVersion, attempt, mutateAsync]);

  if (error === null) return <SearchProgress label={t('common.loading')} />;
  return (
    <div className="space-y-3">
      <Alert variant="destructive">{error}</Alert>
      <Button
        onClick={() => {
          setError(null);
          setAttempt((a) => a + 1);
        }}
      >
        {t('common.retry')}
      </Button>
    </div>
  );
}

/**
 * Shown while the photo is checked and searched: the mascot cat digging through a box of photos
 * (owner, 2026-11-13; transparent background 2026-11-14), in place of a progress bar the API
 * could not feed anyway. One 26 KB sprite of three frames, stepped by CSS; a hashed static file,
 * cached for good. Slid by transform, which keeps moving while the main thread is busy (iOS left
 * a background-position animation still). It always moves, like a spinner (it says "working"),
 * only slower under reduced motion.
 */
export function SearchProgress({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2 py-4 text-center"
      role="status"
      aria-label={label}
    >
      <div className="size-24 overflow-hidden" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- a static sprite, not a photo */}
        <img
          src={CAT_DIG_URL}
          alt=""
          data-testid="search-cat"
          className="h-full w-[300%] max-w-none animate-snap-dig will-change-transform motion-reduce:[animation-duration:1200ms]"
        />
      </div>
      <p className="font-medium">{label}</p>
    </div>
  );
}
