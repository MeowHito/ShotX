'use client';

import {
  ErrorCode,
  type FaceSearchResponse,
  shareExpiredDetailsSchema,
  type ShareItem,
  type ShareMetaResponse,
  type ShareMode,
} from '@shotx/shared';
import { Alert, Button, cn } from '@shotx/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCheckIcon, ChevronUpIcon, RotateCcwIcon, ScanFaceIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DesignCanvas, type DesignCanvasActions } from '@/components/design/design-canvas';
import { HowToSheet } from '@/components/design/how-to-sheet';
import { PublicTopBar } from '@/components/site/public-top-bar';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { ViewerLoginOptions } from '@/lib/auth/viewer-login';
import type { ClientFaceConfig, ClientShareConfig } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import {
  shareKeys,
  useInvalidateShare,
  useShareItems,
  useShareLiveUpdates,
  useShareMeta,
  useSharePrints,
} from '@/lib/share/queries';
import { ShareApiProvider, useShareApi } from '@/lib/share/share-api';
import { DownloadBar, useLightboxDownload } from './download-bar';
import { JustifiedGrid } from './justified-grid';
import { PrintDialog } from './print-dialog';
import { FaceToolsProvider, type FaceTools } from './scan/face-tools';
import { ScanFlow, type ScanSource } from './scan/scan-flow';
import { LoginRequired, PasswordForm, ShareUnavailable } from './share-gates';
import { type ShareRuntime, ShareRuntimeContext, defaultShareRuntime } from './share-runtime';
import { ShareTile } from './share-tile';
import { type LightboxPrint, useLightbox } from './use-lightbox';

export interface SharePageProps {
  /** The ref of the URL: the share's slug, or an old token link (ADR 0011). */
  shareRef: string;
  /** Meta fetched during SSR without the viewer's /api cookies (null when SSR couldn't). */
  initialMeta: ShareMetaResponse | null;
  /** The visitor has a web session (session or refresh cookie). */
  signedIn: boolean;
  /** How a viewer can sign in for a require_login share (default: LINE and Google). */
  viewerLogin?: ViewerLoginOptions;
  faceConfig: ClientFaceConfig;
  shareConfig: ClientShareConfig;
  /** Tests: the fake API, canvas, camera and browser side effects. */
  testing?: {
    publicApi?: ApiClient;
    faceTools?: Partial<Omit<FaceTools, 'config'>>;
    runtime?: Partial<ShareRuntime>;
  };
}

/**
 * The public share page `/[ref]` (client part; see app/[ref]/page.tsx for SSR). ADR 0011
 * layout, mobile first: the top bar (home, language), the centered event title (no cover, ADR 0015),
 * the photos in their own aspect ratios, and a sticky face-search button (share.scan) at the bottom.
 * With a design (ADR 0013, meta.design) the designed card replaces the title as a
 * full-screen first screen under the top bar.
 */
export function SharePage({ testing, ...props }: SharePageProps) {
  const runtime = useMemo(() => ({ ...defaultShareRuntime, ...testing?.runtime }), [testing]);
  // A designed first screen on view: the top bar floats over it (the SSR meta says so up front,
  // so the first paint doesn't shift).
  const [overlay, setOverlay] = useState(props.initialMeta?.design != null);
  // A scan-only designed card is the whole page: no room kept at the bottom for the sticky scan
  // button or the download bar (owner, 2026-11-16, ADR 0028: a blank strip under the card).
  const [compact, setCompact] = useState(
    props.initialMeta?.design != null && props.initialMeta.mode === 'face_only',
  );
  return (
    <ShareApiProvider signedIn={props.signedIn} publicApi={testing?.publicApi}>
      <ShareRuntimeContext.Provider value={runtime}>
        <FaceToolsProvider config={props.faceConfig} overrides={testing?.faceTools}>
          <TopBarOverlayContext.Provider value={setOverlay}>
            <PublicTopBar overlay={overlay} />
            <main className={compact ? undefined : 'pb-36 sm:pb-48'}>
              <CompactPageContext.Provider value={setCompact}>
                <ShareGate {...props} />
              </CompactPageContext.Provider>
            </main>
          </TopBarOverlayContext.Provider>
        </FaceToolsProvider>
      </ShareRuntimeContext.Provider>
    </ShareApiProvider>
  );
}

/** Lets the designed card float the top bar over itself while it is shown. */
const TopBarOverlayContext = createContext<(overlay: boolean) => void>(() => undefined);

/** Drops the page's bottom room while only a scan-only designed card is on it. */
const CompactPageContext = createContext<(compact: boolean) => void>(() => undefined);

/** The page's centred column (everything but a design's full-bleed card). */
function Column({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={cn('mx-auto max-w-5xl px-3 sm:px-6', compact ? null : 'pt-5 sm:pt-8')}>
      {children}
    </div>
  );
}

/**
 * The meta of the page's ref (slug or token). Once the API answered, the URL becomes the
 * canonical one (`meta.path`, the slug) without a reload, and every further call uses
 * `meta.token` (the unlock cookie's path is `/api/s/{token}`).
 */
function ShareGate({ shareRef, initialMeta, shareConfig, viewerLogin }: SharePageProps) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const { signedIn, ensureViewerSession } = useShareApi();
  const invalidate = useInvalidateShare();
  const meta = useShareMeta(shareRef, initialMeta);
  const fresh = meta.data !== undefined && !meta.isPlaceholderData;
  const needsLogin = fresh && meta.data.access.loginRequired;
  const path = meta.data?.path;

  useEffect(() => {
    if (!fresh || path === undefined || window.location.pathname === path) return;
    window.history.replaceState(window.history.state, '', `${path}${window.location.search}`);
  }, [fresh, path]);

  // Signed in but the public routes don't know it yet: create the viewer session once.
  const viewerSession = useQuery({
    queryKey: [...shareKeys.page, 'viewer-session'],
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
        <Column>
          <ShareUnavailable reason={details.success ? details.data.reason : null} />
        </Column>
      );
    }
    return (
      <Column>
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>{describe(meta.error)}</span>
          <Button size="sm" variant="outline" onClick={() => void meta.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      </Column>
    );
  }
  if (!fresh) {
    const design = meta.data?.design ?? null;
    return (
      <>
        {/* SSR's meta: the designed card (inert until the page is live), else the title. */}
        {design !== null && meta.data !== undefined ? (
          <DesignedCard meta={meta.data} design={design} />
        ) : null}
        <Column>
          {meta.data?.details && design === null ? <ShareHeader meta={meta.data} /> : null}
          <p className="py-10 text-center text-muted-foreground" role="status">
            {t('common.loading')}
          </p>
        </Column>
      </>
    );
  }
  if (needsLogin) {
    if (signedIn && viewerSession.data !== false) {
      return (
        <Column>
          <p className="py-10 text-center text-muted-foreground" role="status">
            {t('share.login.connecting')}
          </p>
        </Column>
      );
    }
    return (
      <Column>
        <LoginRequired path={meta.data.path} options={viewerLogin} />
      </Column>
    );
  }
  if (meta.data.access.locked) {
    return (
      <Column>
        <PasswordForm token={meta.data.token} />
      </Column>
    );
  }
  return <ShareContent token={meta.data.token} meta={meta.data} shareConfig={shareConfig} />;
}

/**
 * The event's title, centered and prominent. No cover image (owner, ADR 0015), no photographer
 * name or photo count (ADR 0011). The cover still makes the link's OG image.
 */
function ShareHeader({ meta }: { meta: ShareMetaResponse }) {
  const ts = useTranslations('share');
  const format = useFormatter();
  const details = meta.details;
  if (details === null) return null;
  return (
    <header className="mb-5">
      <div className="space-y-1 text-center">
        <h1 className="text-[clamp(1.6rem,5vw,3rem)] leading-tight font-bold break-words">
          {details.title}
        </h1>
        {meta.expiresAt !== null ? (
          <p className="text-xs text-muted-foreground">
            {ts('expiresAt', {
              date: format.dateTime(new Date(meta.expiresAt), { dateStyle: 'medium' }),
            })}
          </p>
        ) : null}
      </div>
    </header>
  );
}

/**
 * The share's design (ADR 0013) as the full-screen first screen under the top bar: the background
 * fills the screen, the artboard is centred. Without `actions` its buttons are inert. When photos
 * follow (a gallery share, ADR 0019) a "scroll down for all photos" strip closes the first screen,
 * so viewers know the photos are there; the card shrinks by the strip's height to keep it in view.
 */
function DesignedCard({
  meta,
  design,
  actions,
  scanButtonsRef,
}: {
  meta: ShareMetaResponse;
  design: NonNullable<ShareMetaResponse['design']>;
  actions?: DesignCanvasActions;
  scanButtonsRef?: (el: HTMLDivElement | null) => void;
}) {
  const tDesign = useTranslations('share.design');
  const assets = useMemo(
    () => Object.fromEntries(Object.entries(design.assets).map(([id, a]) => [id, a.url])),
    [design.assets],
  );
  const photosBelow = meta.mode === 'gallery';
  const cardRef = useRef<HTMLDivElement>(null);
  const setOverlay = useContext(TopBarOverlayContext);
  useEffect(() => {
    setOverlay(true);
    return () => setOverlay(false);
  }, [setOverlay]);
  return (
    <div ref={cardRef}>
      <DesignCanvas
        doc={design.doc}
        assets={assets}
        mode={meta.mode}
        layout={{ kind: 'fill' }}
        actions={actions}
        scanAvailable={meta.faceSearch.available}
        scanButtonsRef={scanButtonsRef}
        label={tDesign('label')}
        // The first screen is the whole viewport, the artboard included: it starts at the top of
        // the page under the transparent top bar (only the safe area above it), as big as the
        // screen allows (owner, 2026-11-14), less the 3.5rem "all photos" row when photos
        // follow. The artboard fits both the width and the height on every screen, so the whole
        // card (its scan buttons included) is visible without scrolling, also between a phone
        // browser's bars (svh).
        className={
          photosBelow
            ? 'min-h-[calc(100svh-3.5rem)] pt-[env(safe-area-inset-top)] [--design-cap:min(480px,calc((100svh_-_3.5rem_-_env(safe-area-inset-top))_*_390_/_844))]'
            : 'min-h-svh pt-[env(safe-area-inset-top)] [--design-cap:min(480px,calc((100svh_-_env(safe-area-inset-top))_*_390_/_844))]'
        }
      />
      {photosBelow ? (
        <div className="flex h-14 items-center justify-center">
          <button
            type="button"
            disabled={actions === undefined}
            onClick={() =>
              window.scrollTo({
                top: (cardRef.current?.getBoundingClientRect().bottom ?? 0) + window.scrollY - 56,
                behavior: 'smooth',
              })
            }
            className="inline-flex h-10 items-center gap-1.5 rounded-full border-2 border-primary bg-background px-5 text-sm font-semibold text-primary shadow-card transition-colors hover:bg-primary hover:text-primary-foreground"
          >
            {tDesign('seeAll')}
            <ChevronUpIcon className="size-4 motion-safe:animate-bounce" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether an element is on screen (IntersectionObserver). Without the API (old browsers,
 * tests) it counts as on screen.
 */
function useOnScreen(element: Element | null): boolean {
  // The observer's last answer for the element it watched; a new element starts on screen
  // (the card is the first screen) until its observer says otherwise.
  const [seen, setSeen] = useState<{ element: Element; visible: boolean } | null>(null);
  useEffect(() => {
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setSeen({ element, visible: entry.isIntersecting });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  if (element === null) return false;
  return seen !== null && seen.element === element ? seen.visible : true;
}

type TileRenderer = (
  item: ShareItem,
  list: readonly ShareItem[],
  size: { width: number; height: number },
) => ReactNode;

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
  /** The open face-search sheet and what it starts with, or null. */
  const [scanning, setScanning] = useState<ScanSource | null>(null);
  /** The photo picked with the card's "use a photo" button, checked and searched at once. */
  const [pickedPhoto, setPickedPhoto] = useState<Blob | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);
  const [cardButtons, setCardButtons] = useState<HTMLDivElement | null>(null);
  const [results, setResults] = useState<FaceSearchResponse | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, ShareItem>>(new Map());
  // ADR 0031: print orders, when the photographer takes them.
  const prints = useSharePrints(token);
  const printOffer = prints.data?.offer ?? null;
  const orderedFiles = useMemo(
    () =>
      new Set(
        (prints.data?.orders ?? []).filter((o) => o.status !== 'rejected').map((o) => o.fileId),
      ),
    [prints.data],
  );
  const [printItem, setPrintItem] = useState<ShareItem | null>(null);
  const printOpen = useRef(false);
  // The lightbox's share.print.hint note ("you can order N prints"), until the viewer closes it (for this page view).
  const [printHintClosed, setPrintHintClosed] = useState(false);
  useEffect(() => {
    printOpen.current = printItem !== null;
  }, [printItem]);
  // ADR 0020: new photos appear on their own, without a reload or a spinner.
  useShareLiveUpdates(token, shareConfig.livePollMs);

  const onLightboxError = useCallback(
    (err: unknown) => setNotice({ kind: 'error', text: describe(err) }),
    [describe],
  );
  const lightboxDownload = useLightboxDownload(token, onLightboxError);
  // ADR 0031: the print button is in the lightbox (owner, 2026-11-19: not on the grid).
  const lightboxPrint = useMemo<LightboxPrint | undefined>(
    () =>
      printOffer === null
        ? undefined
        : {
            onClick: setPrintItem,
            isAvailable: (item) => item.mediaKind === 'image',
            isOrdered: (item) => orderedFiles.has(item.id),
            isBlocking: () => printOpen.current,
            hint: printHintClosed
              ? null
              : t('share.print.hint', { limit: printOffer.perDeviceLimit }),
            onHintClose: () => setPrintHintClosed(true),
          },
    [printOffer, orderedFiles, printHintClosed, t],
  );
  const openLightbox = useLightbox(
    meta.allowDownload ? lightboxDownload : undefined,
    lightboxPrint,
  );

  const toggle = useCallback((item: ShareItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }, []);
  const selection = useMemo(() => [...selected.values()], [selected]);

  const tile: TileRenderer = (item, list, size) => (
    <ShareTile
      item={item}
      size={size}
      onOpen={() => void openLightbox(list, list.indexOf(item))}
      selection={
        meta.allowDownload
          ? { selected: selected.has(item.id), onToggle: () => toggle(item) }
          : undefined
      }
    />
  );

  // ADR 0013: a design replaces the title until a scan, like the header (ADR 0012).
  const design = meta.design;
  const showCard = design !== null && results === null;
  const cardButtonsOnScreen = useOnScreen(showCard ? cardButtons : null);
  const setCompact = useContext(CompactPageContext);
  const compact = showCard && faceOnly && selection.length === 0;
  useEffect(() => {
    setCompact(compact);
    return () => setCompact(false);
  }, [compact, setCompact]);
  const showFaceButton =
    scanAvailable &&
    scanning === null &&
    selection.length === 0 &&
    // The card's own buttons do the same while they are on screen.
    !(showCard && cardButtonsOnScreen);
  function closeScan() {
    setScanning(null);
    setPickedPhoto(null);
  }
  const cardActions = useMemo<DesignCanvasActions>(
    () => ({
      onCamera: () => setScanning('camera'),
      onChoosePhoto: (photo) => {
        setPickedPhoto(photo);
        setScanning('gallery');
      },
      onHelp: () => setHowToOpen(true),
    }),
    [],
  );

  return (
    <>
      {showCard ? (
        <DesignedCard
          meta={meta}
          design={design}
          actions={cardActions}
          scanButtonsRef={setCardButtons}
        />
      ) : null}
      <Column compact={compact}>
        <div className="space-y-5">
          {/* After a scan the found photos come first: no event title or cover (owner, 2026-11-12). */}
          {results === null && design === null ? <ShareHeader meta={meta} /> : null}

          {faceOnly ? (
            scanAvailable ? (
              showCard ? null : (
                <section className="space-y-2 rounded-xl border bg-sidebar p-5 text-center">
                  <h2 className="font-semibold">{t('share.faceOnly.title')}</h2>
                  <p className="text-sm text-muted-foreground">{t('share.faceOnly.body')}</p>
                </section>
              )
            ) : (
              <Alert variant="warning">{t('share.faceOnly.unavailable')}</Alert>
            )
          ) : null}

          {notice !== null ? (
            <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
              {notice.text}
            </Alert>
          ) : null}

          {results !== null ? (
            <div>
              <ScanResults
                results={results}
                tile={tile}
                allowDownload={meta.allowDownload}
                selected={selected}
                onSelectAll={(items, all) =>
                  setSelected((prev) => {
                    const next = new Map(prev);
                    for (const item of items) {
                      if (all) next.set(item.id, item);
                      else next.delete(item.id);
                    }
                    return next;
                  })
                }
                onRetry={() => {
                  setResults(null);
                  setScanning('camera');
                }}
              />
            </div>
          ) : null}

          {faceOnly ? (
            results === null && scanAvailable ? (
              <ShareGallery
                token={token}
                mode="face_only"
                heading={t('share.yourPhotos')}
                tile={tile}
                hideWhenEmpty
              />
            ) : null
          ) : (
            <ShareGallery
              token={token}
              mode="gallery"
              heading={results !== null ? t('share.allPhotos') : null}
              tile={tile}
            />
          )}

          {showFaceButton ? (
            <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-24">
              <Button
                size="lg"
                className="pointer-events-auto h-14 w-full max-w-md rounded-full text-base shadow-float"
                onClick={() => setScanning('camera')}
              >
                <ScanFaceIcon className="size-6" aria-hidden />
                {results === null ? t('share.scan') : t('share.scanAgain')}
              </Button>
            </div>
          ) : null}

          {scanning !== null && scanAvailable ? (
            <ScanSheet onClose={closeScan}>
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
                // Every share may search with a photo from the device (owner, 2026-11-16, ADR 0028).
                allowGallery
                startWith={scanning}
                photo={pickedPhoto ?? undefined}
                onResults={(r) => {
                  setResults(r);
                  closeScan();
                  setNotice(null);
                  // The results come first on the page: show them from the very top, top bar
                  // included, found or not (owner, 2026-11-13: scrolling to the results left
                  // the page a little way down).
                  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
                }}
                onClose={closeScan}
              />
            </ScanSheet>
          ) : null}

          {design !== null ? <HowToSheet open={howToOpen} onOpenChange={setHowToOpen} /> : null}

          {printOffer !== null && prints.data !== undefined ? (
            <PrintDialog
              token={token}
              item={printItem}
              offer={printOffer}
              used={prints.data.used}
              orders={prints.data.orders}
              onOpenChange={(open) => {
                if (!open) setPrintItem(null);
              }}
            />
          ) : null}

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
      </Column>
    </>
  );
}

/**
 * The face search as a sheet over the page: full screen on phones (so the sticky button at the
 * bottom of a long gallery doesn't open something far above) with the card centered vertically,
 * a centered card on wide screens. Escape closes it.
 */
function ScanSheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 outline-none sm:flex sm:items-center sm:justify-center sm:p-6"
    >
      <div className="flex min-h-full w-full flex-col justify-center bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:block sm:min-h-0 sm:max-w-lg sm:rounded-2xl">
        {children}
      </div>
    </div>
  );
}

/**
 * The face-search result (ADR 0011, ADR 0012): how many photos were found, "select all" (the
 * found photos only; saving goes through the selection bar), then the strong and maybe groups.
 * Nothing found: a friendly message and a retry button back to the camera.
 */
function ScanResults({
  results,
  tile,
  allowDownload,
  selected,
  onSelectAll,
  onRetry,
}: {
  results: FaceSearchResponse;
  tile: TileRenderer;
  allowDownload: boolean;
  selected: ReadonlyMap<string, ShareItem>;
  onSelectAll: (items: readonly ShareItem[], selected: boolean) => void;
  onRetry: () => void;
}) {
  const tr = useTranslations('results');
  const found = useMemo(() => [...results.strong, ...results.maybe], [results]);
  const allSelected = found.length > 0 && found.every((item) => selected.has(item.id));
  const groups = [
    { key: 'strong', items: results.strong },
    { key: 'maybe', items: results.maybe },
  ] as const;

  if (found.length === 0) {
    return (
      <section
        className="space-y-3 rounded-2xl border-2 border-dashed p-6 text-center"
        role="status"
        aria-label={tr('title')}
      >
        {/* Owner feedback 2026-11-12: a plain statement and a retry button, no selfie tips. */}
        {results.selfiesWithoutFace > 0 ? (
          <Alert variant="warning">{tr('noFace')}</Alert>
        ) : (
          <p className="text-lg font-semibold">{tr('none')}</p>
        )}
        <Button size="lg" className="rounded-full" onClick={onRetry}>
          <RotateCcwIcon aria-hidden />
          {tr('retry')}
        </Button>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label={tr('title')}>
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-xl font-bold" aria-live="polite">
          {tr('found', { count: found.length })}
        </h2>
        {allowDownload ? (
          <Button
            variant="outline"
            size="lg"
            className={cn(
              'w-full max-w-md rounded-full',
              allSelected && 'border-primary text-primary',
            )}
            aria-pressed={allSelected}
            onClick={() => onSelectAll(found, !allSelected)}
          >
            <CheckCheckIcon aria-hidden />
            {allSelected ? tr('deselectAll') : tr('selectAll')}
          </Button>
        ) : null}
      </div>
      {groups.map((group) =>
        group.items.length > 0 ? (
          <section key={group.key} aria-label={tr(group.key)} className="space-y-2">
            <h3 className="flex items-baseline gap-2 text-base font-semibold">
              {tr(group.key)}
              <span className="text-sm font-normal text-muted-foreground">
                {tr('groupCount', { count: group.items.length })}
              </span>
            </h3>
            <JustifiedGrid
              items={group.items}
              label={tr(group.key)}
              renderItem={(item, size) => tile(item, group.items, size)}
            />
          </section>
        ) : null,
      )}
    </section>
  );
}

/** The virtualized, cursor-paginated grid of the share's items, in their own aspect ratios. */
function ShareGallery({
  token,
  mode,
  heading,
  tile,
  hideWhenEmpty = false,
}: {
  token: string;
  mode: ShareMode;
  heading: string | null;
  tile: TileRenderer;
  hideWhenEmpty?: boolean;
}) {
  const tg = useTranslations('share');
  const describe = useErrorMessage();
  const listing = useShareItems(token, mode, true);
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
      <JustifiedGrid
        items={listing.items}
        label={tg('galleryLabel')}
        loadingMoreLabel={tg('loadingMore')}
        hasNextPage={listing.hasNextPage}
        isFetchingNextPage={listing.isFetchingNextPage}
        fetchNextPage={listing.fetchNextPage}
        renderItem={(item, size) => tile(item, listing.items, size)}
      />
    </section>
  );
}
