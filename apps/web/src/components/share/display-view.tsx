'use client';

import {
  autoDisplayDoc,
  ErrorCode,
  shareExpiredDetailsSchema,
  type ShareMetaResponse,
} from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { useLocale, useTranslations } from 'next-intl';
import { type ReactNode, useMemo } from 'react';
import {
  DesignCanvas,
  type DesignCanvasAssets,
  type DesignCanvasPhoto,
} from '@/components/design/design-canvas';
import { FullscreenButton } from '@/components/site/fullscreen-button';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { ViewerLoginOptions } from '@/lib/auth/viewer-login';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import type { ClientShareConfig } from '@/lib/face/config';
import { useShareDisplay, useShareLiveUpdates, useShareMeta } from '@/lib/share/queries';
import { ShareApiProvider } from '@/lib/share/share-api';
import { useOrigin } from '@/lib/site/use-origin';
import { LoginRequired, PasswordForm, ShareUnavailable } from './share-gates';

export interface DisplayPageProps {
  /** The ref of the URL (slug or token). */
  shareRef: string;
  signedIn: boolean;
  viewerLogin?: ViewerLoginOptions;
  shareConfig: ClientShareConfig;
  testing?: { publicApi?: ApiClient };
}

/**
 * ADR 0033: the event screen `/{ref}/display`, for a monitor at the event. The link's display
 * design (else the built-in screen on its share page design's background) fills the screen with
 * the newest photos and the link's QR code; scanning the code opens the share page with the
 * share's own design. New photos appear by themselves (ADR 0020 polling); a small corner button
 * shows it full screen.
 */
export function DisplayPage({ testing, ...props }: DisplayPageProps) {
  return (
    <ShareApiProvider signedIn={props.signedIn} publicApi={testing?.publicApi}>
      <main className="relative min-h-svh bg-black">
        <DisplayGate {...props} />
      </main>
    </ShareApiProvider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function DisplayGate({ shareRef, viewerLogin, shareConfig }: Omit<DisplayPageProps, 'testing'>) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const meta = useShareMeta(shareRef, null);
  if (meta.isError) {
    if (isApiError(meta.error, ErrorCode.SHARE_EXPIRED)) {
      const details = shareExpiredDetailsSchema.safeParse(meta.error.details);
      return (
        <Centered>
          <ShareUnavailable reason={details.success ? details.data.reason : null} />
        </Centered>
      );
    }
    return (
      <Centered>
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>{describe(meta.error)}</span>
          <Button size="sm" variant="outline" onClick={() => void meta.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      </Centered>
    );
  }
  if (meta.data === undefined) {
    return (
      <p className="py-10 text-center text-white/60" role="status">
        {t('common.loading')}
      </p>
    );
  }
  if (meta.data.access.loginRequired) {
    return (
      <Centered>
        <LoginRequired path={`${meta.data.path}/display`} options={viewerLogin} />
      </Centered>
    );
  }
  if (meta.data.access.locked) {
    return (
      <Centered>
        <PasswordForm token={meta.data.token} />
      </Centered>
    );
  }
  return <DisplayScreen meta={meta.data} shareConfig={shareConfig} />;
}

function DisplayScreen({
  meta,
  shareConfig,
}: {
  meta: ShareMetaResponse;
  shareConfig: ClientShareConfig;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const origin = useOrigin();
  const display = useShareDisplay(meta.token);
  // New photos and design changes arrive by themselves (ADR 0020).
  useShareLiveUpdates(meta.token, shareConfig.livePollMs);

  const design = display.data?.design ?? null;
  // No display design chosen: the built-in screen on the share page design's background.
  const doc = useMemo(
    () =>
      design?.doc ??
      autoDisplayDoc(meta.details?.title ?? '', meta.design?.doc.background ?? null, locale),
    [design, meta.details, meta.design, locale],
  );
  const assets = useMemo<DesignCanvasAssets>(() => {
    const source = design?.assets ?? meta.design?.assets ?? {};
    return Object.fromEntries(Object.entries(source).map(([id, a]) => [id, a.url]));
  }, [design, meta.design]);
  const photos = useMemo<DesignCanvasPhoto[] | undefined>(
    () =>
      display.data?.photos.map((p) => ({
        id: p.id,
        url: p.mediaKind === 'video' ? (p.posterUrl ?? p.thumbUrl) : p.previewUrl,
      })),
    [display.data],
  );

  return (
    <>
      <DesignCanvas
        doc={doc}
        assets={assets}
        mode={meta.mode}
        layout={{ kind: 'fill' }}
        photos={photos ?? []}
        qrUrl={origin === null ? null : `${origin}${meta.path}`}
        label={t('share.display.label')}
        // The whole screen; the artboard as tall as the screen (no phone-sized cap).
        className="min-h-svh [--design-cap:calc(100svh_*_390_/_844)]"
      />
      {display.isError ? (
        <p className="absolute inset-x-0 bottom-2 text-center text-xs text-white/50" role="status">
          {t('share.display.loadError')}
        </p>
      ) : null}
      <FullscreenButton className="absolute top-3 right-3 z-10 bg-black/20 text-white opacity-40 hover:opacity-100" />
    </>
  );
}
