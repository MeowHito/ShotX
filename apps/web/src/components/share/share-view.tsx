'use client';

import {
  ErrorCode,
  type FaceSearchResponse,
  shareExpiredDetailsSchema,
  type ShareItem,
  type ShareMetaResponse,
} from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { useQuery } from '@tanstack/react-query';
import { ScanFaceIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { DriveGrid } from '@/components/drive/drive-grid';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { ClientFaceConfig, ClientShareConfig } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import {
  shareKeys,
  useInvalidateShare,
  useNotMe,
  useShareItems,
  useShareMeta,
  useWithdrawConsent,
} from '@/lib/share/queries';
import { ShareApiProvider, useShareApi } from '@/lib/share/share-api';
import { DownloadBar, useSingleDownload } from './download-bar';
import { FaceToolsProvider, type FaceTools } from './scan/face-tools';
import { ScanFlow } from './scan/scan-flow';
import { faceDeletionHref, LoginRequired, PasswordForm, ShareUnavailable } from './share-gates';
import { type ShareRuntime, ShareRuntimeContext, defaultShareRuntime } from './share-runtime';
import { ShareTile } from './share-tile';
import { useLightbox } from './use-lightbox';

export interface SharePageProps {
  token: string;
  /** Meta fetched during SSR without the viewer's /api cookies (null when SSR couldn't). */
  initialMeta: ShareMetaResponse | null;
  /** The visitor has a web session (session or refresh cookie). */
  signedIn: boolean;
  faceConfig: ClientFaceConfig;
  shareConfig: ClientShareConfig;
  /** Tests: the fake API, canvas, camera and browser side effects. */
  testing?: {
    publicApi?: ApiClient;
    faceTools?: Partial<Omit<FaceTools, 'config'>>;
    runtime?: Partial<ShareRuntime>;
  };
}

/** The public share page `/s/[token]` (client part; see app/s/[token]/page.tsx for SSR). */
export function SharePage({ testing, ...props }: SharePageProps) {
  const runtime = useMemo(() => ({ ...defaultShareRuntime, ...testing?.runtime }), [testing]);
  return (
    <ShareApiProvider signedIn={props.signedIn} publicApi={testing?.publicApi}>
      <ShareRuntimeContext.Provider value={runtime}>
        <FaceToolsProvider config={props.faceConfig} overrides={testing?.faceTools}>
          <main className="mx-auto max-w-5xl px-3 py-4 pb-40 sm:px-4">
            <ShareGate {...props} />
          </main>
        </FaceToolsProvider>
      </ShareRuntimeContext.Provider>
    </ShareApiProvider>
  );
}

function ShareGate({ token, initialMeta, shareConfig }: SharePageProps) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const { signedIn, ensureViewerSession } = useShareApi();
  const invalidate = useInvalidateShare(token);
  const meta = useShareMeta(token, initialMeta);
  const fresh = meta.data !== undefined && !meta.isPlaceholderData;
  const needsLogin = fresh && meta.data.access.loginRequired;

  // Signed in but the public routes don't know it yet: create the viewer session once.
  const viewerSession = useQuery({
    queryKey: [...shareKeys.all(token), 'viewer-session'],
    queryFn: async () => {
      const ok = await ensureViewerSession();
      if (ok) await invalidate();
      return ok;
    },
    enabled: needsLogin && signedIn,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (meta.isError) {
    if (isApiError(meta.error, ErrorCode.SHARE_EXPIRED)) {
      const details = shareExpiredDetailsSchema.safeParse(meta.error.details);
      return (
        <ShareUnavailable token={token} reason={details.success ? details.data.reason : null} />
      );
    }
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-2">
        <span>{describe(meta.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void meta.refetch()}>
          {t('common.retry')}
        </Button>
      </Alert>
    );
  }
  if (!fresh) {
    return (
      <>
        {meta.data?.details ? <ShareHeader meta={meta.data} /> : null}
        <p className="py-10 text-center text-muted-foreground" role="status">
          {t('common.loading')}
        </p>
      </>
    );
  }
  if (needsLogin) {
    if (signedIn && viewerSession.data !== false) {
      return (
        <p className="py-10 text-center text-muted-foreground" role="status">
          {t('share.login.connecting')}
        </p>
      );
    }
    return <LoginRequired token={token} />;
  }
  if (meta.data.access.locked) return <PasswordForm token={token} />;
  return <ShareContent token={token} meta={meta.data} shareConfig={shareConfig} />;
}

function ShareHeader({ meta }: { meta: ShareMetaResponse }) {
  const th = useTranslations('share');
  const format = useFormatter();
  const details = meta.details;
  if (details === null) return null;
  return (
    <header className="mb-4 space-y-1">
      <h1 className="text-xl font-bold break-words sm:text-2xl">{details.title}</h1>
      <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
        {details.photographerName !== null ? (
          <span>{th('byPhotographer', { name: details.photographerName })}</span>
        ) : null}
        {details.itemCount !== null ? (
          <span>{th('itemCount', { count: details.itemCount })}</span>
        ) : null}
        {meta.expiresAt !== null ? (
          <span>
            {th('expiresAt', {
              date: format.dateTime(new Date(meta.expiresAt), { dateStyle: 'medium' }),
            })}
          </span>
        ) : null}
      </p>
    </header>
  );
}

function ShareContent({
  token,
  meta,
  shareConfig,
}: {
  token: string;
  meta: ShareMetaResponse;
  shareConfig: ClientShareConfig;
}) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const faceOnly = meta.mode === 'face_only';
  const scanAvailable = meta.faceSearch.available;
  const [scanning, setScanning] = useState(false);
  const maxSelection = meta.zip.maxFiles;
  const [results, setResults] = useState<FaceSearchResponse | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, ShareItem>>(new Map());
  const withdraw = useWithdrawConsent(token);
  const notMe = useNotMe(token);
  const single = useSingleDownload(token);

  const onLightboxDownload = useCallback(
    (item: ShareItem) => {
      single(item).catch((err: unknown) => setNotice({ kind: 'error', text: describe(err) }));
    },
    [single, describe],
  );
  const openLightbox = useLightbox(meta.allowDownload ? onLightboxDownload : undefined);

  const toggle = useCallback(
    (item: ShareItem) => {
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(item.id)) next.delete(item.id);
        else if (next.size < maxSelection) next.set(item.id, item);
        return next;
      });
    },
    [maxSelection],
  );
  const selection = useMemo(() => [...selected.values()], [selected]);

  const tile = (item: ShareItem, list: readonly ShareItem[], extra?: { notMe?: boolean }) => (
    <ShareTile
      item={item}
      onOpen={() => void openLightbox(list, list.indexOf(item))}
      selection={
        meta.allowDownload
          ? { selected: selected.has(item.id), onToggle: () => toggle(item) }
          : undefined
      }
      onNotMe={extra?.notMe ? () => void rejectMatch(item) : undefined}
      notMeBusy={notMe.isPending}
    />
  );

  async function rejectMatch(item: ShareItem) {
    try {
      await notMe.mutateAsync(item.id);
      setResults((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              strong: prev.strong.filter((i) => i.id !== item.id),
              maybe: prev.maybe.filter((i) => i.id !== item.id),
            },
      );
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(item.id);
        return next;
      });
      setNotice({ kind: 'info', text: t('results.notMeDone') });
    } catch (err) {
      setNotice({ kind: 'error', text: describe(err) });
    }
  }

  async function withdrawConsent() {
    try {
      await withdraw.mutateAsync();
      setResults(null);
      setScanning(false);
      setSelected(new Map());
      setNotice({ kind: 'info', text: t('share.withdrawn') });
    } catch (err) {
      setNotice({ kind: 'error', text: describe(err) });
    }
  }

  const scanButton =
    scanAvailable && !scanning ? (
      <Button size="lg" className="w-full sm:w-auto" onClick={() => setScanning(true)}>
        <ScanFaceIcon aria-hidden />
        {results === null ? t('share.scan') : t('share.scanAgain')}
      </Button>
    ) : null;

  return (
    <div className="space-y-5">
      <ShareHeader meta={meta} />

      {faceOnly ? (
        scanAvailable ? (
          <section className="space-y-2 rounded-xl bg-muted p-4">
            <h2 className="font-semibold">{t('share.faceOnly.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('share.faceOnly.body')}</p>
          </section>
        ) : (
          <Alert variant="warning">{t('share.faceOnly.unavailable')}</Alert>
        )
      ) : null}

      {scanButton}

      {notice !== null ? (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
          {notice.text}
        </Alert>
      ) : null}

      {scanning && scanAvailable ? (
        <ScanFlow
          token={token}
          purpose="search"
          consent={{
            policyVersion: meta.faceSearch.policyVersion,
            consented: meta.faceSearch.consented,
            resultTtlSeconds: meta.faceSearch.resultTtlSeconds,
          }}
          limits={{
            maxSelfies: meta.faceSearch.maxSelfies,
            selfie: {
              longEdge: meta.faceSearch.selfieLongEdge,
              jpegQuality: meta.faceSearch.selfieJpegQuality,
            },
          }}
          allowGallery={meta.mode === 'gallery'}
          onResults={(r) => {
            setResults(r);
            setScanning(false);
            setNotice(null);
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}

      {results !== null ? <ScanResults results={results} tile={tile} /> : null}

      {faceOnly ? (
        results === null && scanAvailable ? (
          <ShareGallery token={token} heading={t('share.yourPhotos')} tile={tile} hideWhenEmpty />
        ) : null
      ) : (
        <ShareGallery
          token={token}
          heading={results !== null ? t('share.allPhotos') : null}
          tile={tile}
        />
      )}

      {/* "delete my face" is a PDPA right: offered whether or not face search is on. */}
      <footer className="flex flex-col items-start gap-1 border-t pt-4 text-sm">
        <Link
          href={faceDeletionHref(token)}
          className="text-primary underline-offset-4 hover:underline"
        >
          {t('share.deleteMyFace')}
        </Link>
        {meta.faceSearch.consented ? (
          <Button
            variant="link"
            className="h-auto p-0 text-muted-foreground"
            onClick={() => void withdrawConsent()}
            disabled={withdraw.isPending}
          >
            {t('share.withdraw')}
          </Button>
        ) : null}
      </footer>

      {meta.allowDownload ? (
        <DownloadBar
          token={token}
          selection={selection}
          downloadSize={meta.downloadSize}
          config={shareConfig}
          onClear={() => setSelected(new Map())}
        />
      ) : null}
    </div>
  );
}

type TileRenderer = (
  item: ShareItem,
  list: readonly ShareItem[],
  extra?: { notMe?: boolean },
) => ReactNode;

/** The "strong" (it's you) and "maybe" groups, each photo with a "not me" button. */
function ScanResults({ results, tile }: { results: FaceSearchResponse; tile: TileRenderer }) {
  const tr = useTranslations('results');
  const groups = [
    { key: 'strong', items: results.strong },
    { key: 'maybe', items: results.maybe },
  ] as const;
  const empty = results.strong.length === 0 && results.maybe.length === 0;
  return (
    <div className="space-y-5">
      {results.selfiesWithoutFace > 0 ? (
        <Alert variant="warning">
          {tr('partialNoFace', { count: results.selfiesWithoutFace })}
        </Alert>
      ) : null}
      {empty ? (
        <div className="rounded-xl border-2 border-dashed p-6 text-center" role="status">
          <p className="font-medium">{tr('none')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tr('noneHint')}</p>
        </div>
      ) : (
        groups.map((group) =>
          group.items.length > 0 ? (
            <section key={group.key} aria-label={tr(group.key)} className="space-y-2">
              <h2 className="flex items-baseline gap-2 text-lg font-semibold">
                {tr(group.key)}
                <span className="text-sm font-normal text-muted-foreground">
                  {tr('groupCount', { count: group.items.length })}
                </span>
              </h2>
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {group.items.map((item) => (
                  <li key={item.id}>{tile(item, group.items, { notMe: true })}</li>
                ))}
              </ul>
            </section>
          ) : null,
        )
      )}
    </div>
  );
}

/** The virtualized, cursor-paginated grid of the share's items. */
function ShareGallery({
  token,
  heading,
  tile,
  hideWhenEmpty = false,
}: {
  token: string;
  heading: string | null;
  tile: TileRenderer;
  hideWhenEmpty?: boolean;
}) {
  const tg = useTranslations('share');
  const describe = useErrorMessage();
  const listing = useShareItems(token, true);
  if (listing.isError) {
    return (
      <Alert variant="destructive">
        {tg('loadError')}: {describe(listing.error)}
      </Alert>
    );
  }
  if (listing.isPending) return null;
  if (listing.items.length === 0) {
    return hideWhenEmpty ? null : (
      <p className="py-10 text-center text-muted-foreground">{tg('empty')}</p>
    );
  }
  return (
    <section className="space-y-2">
      {heading !== null ? <h2 className="text-lg font-semibold">{heading}</h2> : null}
      <DriveGrid
        items={listing.items}
        label={tg('galleryLabel')}
        loadingMoreLabel={tg('loadingMore')}
        hasNextPage={listing.hasNextPage}
        isFetchingNextPage={listing.isFetchingNextPage}
        fetchNextPage={listing.fetchNextPage}
        minCellPx={110}
        captionPx={0}
        gapPx={4}
        renderItem={(item) => tile(item, listing.items)}
      />
    </section>
  );
}
