'use client';

import {
  DESIGN_ARTBOARD,
  DESIGN_NAME_MAX_LENGTH,
  DESIGN_ROUTES,
  type Design,
  type DesignAssetView,
  type DesignLimits,
  designDocAssetIds,
  designShowsPhotos,
} from '@shotx/shared';
import { Alert, Button, Checkbox, cn } from '@shotx/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  EyeIcon,
  KeyboardIcon,
  LoaderCircleIcon,
  MaximizeIcon,
  Redo2Icon,
  RotateCcwIcon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { DESIGNS_HREF } from '@/components/drive/paths';
import { useApiClient } from '@/components/providers';
import { PHONE_QUERY, useApplePlatform, useMediaQuery } from '@/components/studio/studio-context';
import { editorReducer, initialEditorState } from '@/lib/design/editor-state';
import { docColors, makeShape, makeText } from '@/lib/design/elements';
import { designKeys, useDesign, useDesigns } from '@/lib/design/queries';
import { designShortcut } from '@/lib/design/shortcuts';
import { type SaveStatus, useAutosave } from '@/lib/design/use-autosave';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { shouldIgnoreKey } from '@/lib/studio/shortcuts';
import { DesignPreview } from '../design-preview';
import { DesignShortcutsDialog, PreviewDialog } from './dialogs';
import { EditorContext, type EditorContextValue } from './editor-context';
import { LeftPanel, type PanelId, type UploadRuntime } from './left-panel';
import { PropertiesPanel } from './properties-panel';
import { STAGE_PADDING, Stage } from './stage';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** How often images still processing are checked, ms. */
const ASSET_POLL_MS = 2000;

export interface DesignEditorRuntime extends UploadRuntime {
  /** Autosave delay (DESIGN_AUTOSAVE_DELAY_MS by default). */
  autosaveDelayMs?: number;
  /** Polling of images still processing. */
  assetPollMs?: number;
}

/**
 * `/studio/designs/[id]`: loads the design and the limits, then the editor; phones get a
 * read-only preview with a note (ADR 0013: desktop first, tablets work). A revision conflict's
 * "reload" loads the design again and starts a fresh editor.
 */
export function DesignEditorPage({
  designId,
  runtime,
}: {
  designId: string;
  runtime?: DesignEditorRuntime;
}) {
  const t = useTranslations('designs.editor');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const phone = useMediaQuery(PHONE_QUERY);
  const design = useDesign(designId);
  const list = useDesigns();
  const [session, setSession] = useState(0);

  const reload = useCallback(async () => {
    await design.refetch();
    setSession((s) => s + 1);
  }, [design]);

  const frame = (children: ReactNode) => (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">{children}</div>
  );

  if (design.isError || list.isError) {
    return frame(
      <div className="m-auto grid max-w-md gap-3 p-6 text-center">
        <Alert variant="destructive">{describe(design.error ?? list.error)}</Alert>
        <Link
          href={DESIGNS_HREF}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {t('back')}
        </Link>
      </div>,
    );
  }
  if (design.data === undefined || list.data === undefined) {
    return frame(
      <p className="m-auto text-muted-foreground" role="status">
        {t('loading')}
      </p>,
    );
  }
  if (phone) {
    return frame(
      <>
        <header className="flex h-14 items-center gap-2 border-b px-3">
          <Button asChild variant="ghost" size="icon" aria-label={t('back')}>
            <Link href={DESIGNS_HREF}>
              <ArrowLeftIcon aria-hidden />
            </Link>
          </Button>
          <h1 className="truncate font-semibold">{design.data.name}</h1>
        </header>
        <div className="grid flex-1 justify-items-center gap-4 overflow-y-auto p-4">
          <Alert>{t('phoneNote')}</Alert>
          <DesignPreview
            doc={design.data.doc}
            assets={Object.fromEntries(
              Object.entries(design.data.assets).map(([id, a]) => [id, a.url]),
            )}
            width={300}
            className="rounded-2xl border shadow-card"
          />
          <Button asChild variant="outline">
            <Link href={DESIGNS_HREF}>{tc('close')}</Link>
          </Button>
        </div>
      </>,
    );
  }
  return frame(
    <DesignEditor
      key={session}
      design={design.data}
      limits={list.data.limits}
      onReload={reload}
      runtime={runtime}
    />,
  );
}

/** The designer itself (see the ADR for the layout); `design` is the loaded state. */
export function DesignEditor({
  design,
  limits,
  onReload,
  runtime,
}: {
  design: Design;
  limits: DesignLimits;
  onReload: () => Promise<void>;
  runtime?: DesignEditorRuntime;
}) {
  const t = useTranslations('designs.editor');
  const api = useApiClient();
  const queryClient = useQueryClient();
  const apple = useApplePlatform();
  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    initialEditorState(design.doc, design.name, limits.maxElements),
  );
  const [assets, setAssets] = useState<Record<string, DesignAssetView>>(design.assets);
  const [panel, setPanel] = useState<PanelId>('templates');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitZoom, setFitZoom] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const effectiveZoom = zoom ?? fitZoom;

  const autosave = useAutosave({
    api,
    designId: design.id,
    doc: state.doc,
    name: state.name,
    version: state.version,
    baseVersion: 0,
    revision: design.revision,
    limits,
    delayMs: runtime?.autosaveDelayMs,
    onSaved: (saved) => {
      queryClient.setQueryData(designKeys.one(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: designKeys.list });
    },
  });

  const putAssets = useCallback((list: readonly DesignAssetView[]) => {
    setAssets((prev) => {
      const next = { ...prev };
      for (const a of list) next[a.id] = a;
      return next;
    });
  }, []);

  // Images still being prepared (on the design, or just uploaded and shown in the uploads list):
  // show a spinner and check until ready. The worker may take minutes while a big event's photos
  // are processing, longer than an upload's own wait (owner, 2026-11-13).
  const pendingAssets = useMemo(
    () =>
      new Set(
        // Known images still being prepared; unknown or failed ones simply draw nothing.
        [...designDocAssetIds(state.doc), ...Object.keys(assets)].filter((id) => {
          const status = assets[id]?.status;
          return status === 'uploading' || status === 'processing';
        }),
      ),
    [state.doc, assets],
  );
  const pendingKey = [...pendingAssets].join(',');
  useEffect(() => {
    if (pendingKey === '') return;
    const ids = pendingKey.split(',');
    const timer = setInterval(() => {
      for (const id of ids) {
        api
          .call(DESIGN_ROUTES.getAsset, { params: { id } })
          .then((a) => putAssets([a]))
          .catch(() => undefined);
      }
    }, runtime?.assetPollMs ?? ASSET_POLL_MS);
    return () => clearInterval(timer);
  }, [pendingKey, api, putAssets, runtime?.assetPollMs]);

  // Fit: the whole artboard in the stage.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = () => {
      const w = el.clientWidth - 2 * STAGE_PADDING;
      const h = el.clientHeight - 2 * STAGE_PADDING;
      if (w <= 0 || h <= 0) return;
      const fit = Math.min(w / DESIGN_ARTBOARD.width, h / DESIGN_ARTBOARD.height);
      setFitZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoomBy = useCallback(
    (factor: number) =>
      setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (z ?? fitZoom) * factor))),
    [fitZoom],
  );

  // Keyboard shortcuts (ADR 0013), off while typing in a field or editing a text in place. In
  // the capture phase, before the studio's own shortcuts (which skip handled events).
  const handlers = useRef({ state, editingId, autosave, zoomBy });
  useEffect(() => {
    handlers.current = { state, editingId, autosave, zoomBy };
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || shouldIgnoreKey(event) || handlers.current.editingId !== null)
        return;
      if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      const command = designShortcut(event, apple);
      if (command === null) return;
      event.preventDefault();
      event.stopPropagation();
      switch (command.id) {
        case 'undo':
        case 'redo':
        case 'delete':
        case 'duplicate':
        case 'copy':
        case 'paste':
        case 'selectAll':
        case 'deselect':
          dispatch({ type: command.id });
          return;
        case 'nudge':
          dispatch({ type: 'nudge', dx: command.dx, dy: command.dy });
          return;
        case 'forward':
        case 'backward':
        case 'front':
        case 'back':
          dispatch({ type: 'order', move: command.id });
          return;
        case 'addText':
          dispatch({ type: 'add', element: makeText('body', t('text.bodyText')) });
          return;
        case 'addRect':
          dispatch({ type: 'add', element: makeShape('rect') });
          return;
        case 'addEllipse':
          dispatch({ type: 'add', element: makeShape('ellipse') });
          return;
        case 'lock':
          dispatch({ type: 'toggleLock' });
          return;
        case 'save':
          handlers.current.autosave.saveNow();
          return;
        case 'zoomIn':
          handlers.current.zoomBy(ZOOM_STEP);
          return;
        case 'zoomOut':
          handlers.current.zoomBy(1 / ZOOM_STEP);
          return;
        case 'zoomFit':
          setZoom(null);
          return;
        case 'help':
          setHelpOpen(true);
          return;
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') setSpaceHeld(false);
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [apple, t]);

  const swatches = useMemo(() => docColors(state.doc), [state.doc]);
  const context = useMemo<EditorContextValue>(
    () => ({ state, dispatch, assets, putAssets, limits, swatches, editText: setEditingId }),
    [state, assets, putAssets, limits, swatches],
  );
  const urls = useMemo(
    () => Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, a.url])),
    [assets],
  );

  /** Space+drag: scroll the stage with the pointer until it is released. */
  function startPan(x: number, y: number) {
    const el = scrollRef.current;
    if (el === null) return;
    const start = { x, y, left: el.scrollLeft, top: el.scrollTop };
    setPanning(true);
    const move = (event: PointerEvent) => {
      el.scrollLeft = start.left - (event.clientX - start.x);
      el.scrollTop = start.top - (event.clientY - start.y);
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  async function reload() {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  }

  return (
    <EditorContext.Provider value={context}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
        <Button asChild variant="ghost" size="icon" aria-label={t('back')}>
          <Link href={DESIGNS_HREF}>
            <ArrowLeftIcon aria-hidden />
          </Link>
        </Button>
        <input
          aria-label={t('name')}
          value={state.name}
          maxLength={DESIGN_NAME_MAX_LENGTH}
          onChange={(e) => dispatch({ type: 'rename', name: e.target.value })}
          className="h-9 w-56 min-w-0 rounded-md border border-transparent bg-transparent px-2 font-semibold hover:border-border focus:border-input"
        />
        <SaveState
          status={autosave.status}
          error={autosave.error}
          onRetry={autosave.saveNow}
          onReload={() => void reload()}
          reloading={reloading}
        />
        {/* ADR 0019: off = viewers see no photos and must scan their face. */}
        <label
          className="ml-2 flex shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          title={t('showPhotosHint')}
        >
          <Checkbox
            checked={designShowsPhotos(state.doc)}
            onCheckedChange={(v) => dispatch({ type: 'showPhotos', value: v === true })}
          />
          {t('showPhotos')}
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('undo')}
            title={t('undo')}
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <Undo2Icon aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('redo')}
            title={t('redo')}
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
          >
            <Redo2Icon aria-hidden />
          </Button>
          <span className="mx-1 h-6 w-px bg-border" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('zoomOut')}
            title={t('zoomOut')}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <ZoomOutIcon aria-hidden />
          </Button>
          <span className="w-12 text-center text-xs tabular-nums" aria-live="polite">
            {t('zoom', { percent: Math.round(effectiveZoom * 100) })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('zoomIn')}
            title={t('zoomIn')}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <ZoomInIcon aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('zoomFit')}
            title={t('zoomFit')}
            onClick={() => setZoom(null)}
          >
            <MaximizeIcon aria-hidden />
          </Button>
          <span className="mx-1 h-6 w-px bg-border" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('shortcuts')}
            title={t('shortcuts')}
            onClick={() => setHelpOpen(true)}
          >
            <KeyboardIcon aria-hidden />
          </Button>
          <Button variant="outline" onClick={() => setPreviewOpen(true)}>
            <EyeIcon aria-hidden />
            {t('preview')}
          </Button>
        </div>
      </header>
      {state.blocked !== null ? (
        <Alert variant="warning" className="rounded-none border-x-0 py-2 text-sm" role="status">
          {state.blocked === 'limit'
            ? t('limit', { max: limits.maxElements })
            : t('props.cantDelete')}
        </Alert>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <LeftPanel panel={panel} onPanel={setPanel} uploadRuntime={runtime} />
        <div
          ref={scrollRef}
          className={cn(
            'relative min-w-0 flex-1 overflow-auto bg-muted',
            spaceHeld && 'cursor-grab',
            panning && 'cursor-grabbing select-none',
          )}
          onPointerDown={(e) => {
            if (spaceHeld && e.button === 0) {
              startPan(e.clientX, e.clientY);
              return;
            }
            // Outside the artboard: deselect.
            if (e.target === e.currentTarget) dispatch({ type: 'deselect' });
          }}
        >
          <div
            className="flex min-h-full min-w-fit items-center justify-center"
            style={{ padding: STAGE_PADDING }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget && !spaceHeld) dispatch({ type: 'deselect' });
            }}
          >
            <Stage
              zoom={effectiveZoom}
              spaceHeld={spaceHeld}
              editingId={editingId}
              onEditText={setEditingId}
              pendingAssets={pendingAssets}
            />
          </div>
        </div>
        <PropertiesPanel />
      </div>
      <PreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        doc={state.doc}
        assets={urls}
      />
      <DesignShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} apple={apple} />
    </EditorContext.Provider>
  );
}

function SaveState({
  status,
  error,
  onRetry,
  onReload,
  reloading,
}: {
  status: SaveStatus;
  error: unknown;
  onRetry: () => void;
  onReload: () => void;
  reloading: boolean;
}) {
  const ts = useTranslations('designs.editor.status');
  const describe = useErrorMessage();
  if (status === 'conflict') {
    return (
      <div
        className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900"
        role="alert"
      >
        <CircleAlertIcon className="size-4" aria-hidden />
        <span>{ts('conflict')}</span>
        <Button size="sm" variant="outline" className="h-7" onClick={onReload} disabled={reloading}>
          <RotateCcwIcon aria-hidden />
          {ts('reload')}
        </Button>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
        <CircleAlertIcon className="size-4" aria-hidden />
        <span title={describe(error)}>{ts('error')}</span>
        <Button size="sm" variant="outline" className="h-7" onClick={onRetry}>
          {ts('retry')}
        </Button>
      </div>
    );
  }
  const icon =
    status === 'saving' ? (
      <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
    ) : status === 'saved' ? (
      <CircleCheckIcon className="size-4 text-emerald-600" aria-hidden />
    ) : status === 'invalid' ? (
      <CircleAlertIcon className="size-4 text-destructive" aria-hidden />
    ) : null;
  return (
    <span
      className="flex items-center gap-1 text-xs text-muted-foreground"
      role="status"
      data-save-status={status}
    >
      {icon}
      {ts(status)}
    </span>
  );
}
