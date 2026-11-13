'use client';

import {
  DESIGN_ASSET_MIME_TYPES,
  DESIGN_TEMPLATE_IDS,
  type DesignAssetView,
  type DesignBackground,
  type DesignElement,
  designTemplateDoc,
} from '@shotx/shared';
import { Alert, cn } from '@shotx/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
  CircleHelpIcon,
  CircleIcon,
  EyeIcon,
  EyeOffIcon,
  GripVerticalIcon,
  ImageIcon,
  LayersIcon,
  LayoutTemplateIcon,
  LoaderCircleIcon,
  LockIcon,
  MinusIcon,
  PaintBucketIcon,
  ScanFaceIcon,
  ShapesIcon,
  SquareIcon,
  TypeIcon,
  UnlockIcon,
  UploadIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { type DragEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { useApiClient } from '@/components/providers';
import {
  canAddType,
  isDeletable,
  makeHelpButton,
  makeImage,
  makeShape,
  makeText,
  type ShapePreset,
  type TextPreset,
} from '@/lib/design/elements';
import { designFontFamily } from '@/lib/design/fonts';
import { designKeys, useDesignAssets } from '@/lib/design/queries';
import { uploadDesignImage } from '@/lib/design/upload';
import { ClientError } from '@/lib/errors/messages';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormatBytes } from '@/lib/i18n/use-format';
import { DesignPreview } from '../design-preview';
import { useEditor } from './editor-context';
import { ColorField, SliderField } from './fields';

export type PanelId = 'templates' | 'text' | 'shapes' | 'uploads' | 'background' | 'layers';

const PANELS: { id: PanelId; icon: typeof TypeIcon }[] = [
  { id: 'templates', icon: LayoutTemplateIcon },
  { id: 'text', icon: TypeIcon },
  { id: 'shapes', icon: ShapesIcon },
  { id: 'uploads', icon: UploadIcon },
  { id: 'background', icon: PaintBucketIcon },
  { id: 'layers', icon: LayersIcon },
];

/** How the presigned PUT and the polls run (tests: the fake bucket, no waiting). */
export interface UploadRuntime {
  putObject?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

/**
 * The left side of the designer: tool tabs (Templates, Text, Shapes, Uploads, Background,
 * Layers) and the open tab's panel.
 */
export function LeftPanel({
  panel,
  onPanel,
  uploadRuntime,
}: {
  panel: PanelId;
  onPanel: (panel: PanelId) => void;
  uploadRuntime?: UploadRuntime;
}) {
  const tPanels = useTranslations('designs.editor.panels');
  const tabsId = useId();
  return (
    <aside className="flex h-full min-h-0 border-r bg-sidebar">
      <div
        role="tablist"
        aria-label={tPanels('label')}
        aria-orientation="vertical"
        className="flex w-[4.5rem] shrink-0 flex-col gap-1 border-r p-1.5"
      >
        {PANELS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${tabsId}-${id}`}
            aria-selected={panel === id}
            aria-controls={`${tabsId}-panel`}
            onClick={() => onPanel(id)}
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] leading-tight transition-colors',
              panel === id
                ? 'bg-background font-semibold text-primary shadow-card'
                : 'text-muted-foreground hover:bg-background/70',
            )}
          >
            <Icon className="size-5" aria-hidden />
            {tPanels(id)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${panel}`}
        className="w-64 min-h-0 overflow-y-auto p-3"
      >
        {panel === 'templates' ? <TemplatesPanel /> : null}
        {panel === 'text' ? <TextPanel /> : null}
        {panel === 'shapes' ? <ShapesPanel /> : null}
        {panel === 'uploads' ? <UploadsPanel runtime={uploadRuntime} /> : null}
        {panel === 'background' ? <BackgroundPanel /> : null}
        {panel === 'layers' ? <LayersPanel /> : null}
      </div>
    </aside>
  );
}

function TemplatesPanel() {
  const tDesigns = useTranslations('designs');
  const locale = useLocale();
  const { dispatch } = useEditor();
  const docs = useMemo(
    () => DESIGN_TEMPLATE_IDS.map((id) => ({ id, doc: designTemplateDoc(id, locale) })),
    [locale],
  );
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">{tDesigns('editor.templatesHint')}</p>
      <div className="grid grid-cols-2 gap-2">
        {docs.map(({ id, doc }) => (
          <button
            key={id}
            type="button"
            onClick={() => dispatch({ type: 'replaceDoc', doc: designTemplateDoc(id, locale) })}
            className="grid gap-1 rounded-lg border p-1 text-xs hover:border-primary"
          >
            <DesignPreview doc={doc} assets={{}} width={104} className="rounded" />
            <span>{tDesigns(`templates.${id}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TextPanel() {
  const tText = useTranslations('designs.editor.text');
  const { dispatch, editText } = useEditor();
  const presets: { id: TextPreset; label: string; text: string; className: string }[] = [
    {
      id: 'heading',
      label: tText('heading'),
      text: tText('headingText'),
      className: 'text-xl font-bold',
    },
    {
      id: 'subheading',
      label: tText('subheading'),
      text: tText('subheadingText'),
      className: 'text-base font-semibold',
    },
    { id: 'body', label: tText('body'), text: tText('bodyText'), className: 'text-sm' },
  ];
  return (
    <div className="grid gap-2">
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className={cn(
            'rounded-lg border bg-background px-3 py-3 text-left hover:border-primary',
            p.className,
          )}
          style={{ fontFamily: designFontFamily(p.id === 'body' ? 'sarabun' : 'kanit') }}
          onClick={() => {
            const element = makeText(p.id, p.text);
            dispatch({ type: 'add', element });
            editText(element.id);
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function ShapesPanel() {
  const tShapes = useTranslations('designs.editor.shapes');
  const { state, dispatch } = useEditor();
  const shapes: { id: ShapePreset; icon: ReactNode }[] = [
    { id: 'rect', icon: <SquareIcon className="size-6" aria-hidden /> },
    { id: 'ellipse', icon: <CircleIcon className="size-6" aria-hidden /> },
    { id: 'line', icon: <MinusIcon className="size-6" aria-hidden /> },
    {
      id: 'glass',
      icon: (
        <span
          className="block h-6 w-8 rounded-md border border-white/80 bg-gradient-to-br from-sky-200/80 to-violet-200/80 shadow-inner"
          aria-hidden
        />
      ),
    },
  ];
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        {shapes.map((s) => (
          <button
            key={s.id}
            type="button"
            className="flex flex-col items-center gap-1.5 rounded-lg border bg-background p-3 text-xs hover:border-primary"
            onClick={() => dispatch({ type: 'add', element: makeShape(s.id) })}
          >
            {s.icon}
            {tShapes(s.id)}
          </button>
        ))}
      </div>
      {canAddType(state.doc, 'helpButton') ? (
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border bg-background p-3 text-xs hover:border-primary"
          onClick={() => dispatch({ type: 'add', element: makeHelpButton() })}
        >
          <CircleHelpIcon className="size-5" aria-hidden />
          {tShapes('helpButton')}
        </button>
      ) : null}
    </div>
  );
}

interface UploadItem {
  key: string;
  name: string;
  status: 'uploading' | 'processing' | 'failed';
  error: string | null;
}

/** The images of the uploads list and the editor's own, newest first, without failed ones. */
function useImageList(): DesignAssetView[] {
  const { assets } = useEditor();
  const listed = useDesignAssets();
  return useMemo(() => {
    const map = new Map<string, DesignAssetView>();
    for (const a of listed.data?.items ?? []) map.set(a.id, a);
    // The editor's copy is usually fresher, but never hide a list entry that is already ready.
    for (const a of Object.values(assets)) {
      if (map.get(a.id)?.status !== 'ready') map.set(a.id, a);
    }
    return [...map.values()]
      .filter((a) => a.status !== 'failed')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [listed.data, assets]);
}

export function UploadsPanel({ runtime }: { runtime?: UploadRuntime }) {
  const tUploads = useTranslations('designs.editor.uploads');
  const api = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const formatBytes = useFormatBytes();
  const { dispatch, putAssets, limits } = useEditor();
  const images = useImageList();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputId = useId();

  function patch(key: string, change: Partial<UploadItem>) {
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }

  async function upload(file: File) {
    const key = `${file.name}-${Date.now()}-${Math.random()}`;
    setUploads((prev) => [...prev, { key, name: file.name, status: 'uploading', error: null }]);
    try {
      const asset = await uploadDesignImage(file, {
        api,
        maxBytes: limits.assetMaxBytes,
        putObject: runtime?.putObject,
        sleep: runtime?.sleep,
        pollIntervalMs: runtime?.pollIntervalMs,
        onProgress: (a) => {
          putAssets([a]);
          patch(key, { status: 'processing' });
        },
      });
      putAssets([asset]);
      setUploads((prev) => prev.filter((u) => u.key !== key));
      // A new image goes straight onto the design.
      dispatch({ type: 'add', element: makeImage(asset.id, asset) });
      void queryClient.invalidateQueries({ queryKey: designKeys.assets });
    } catch (err) {
      if (err instanceof ClientError && err.key === 'client.designAssetTimeout') {
        // Still being prepared (the worker can be busy with an event's photos): the image stays
        // in the list with its spinner, which checks until it is ready.
        setUploads((prev) => prev.filter((u) => u.key !== key));
        void queryClient.invalidateQueries({ queryKey: designKeys.assets });
        return;
      }
      patch(key, { status: 'failed', error: describe(err) });
    }
  }

  function addFiles(files: Iterable<File>) {
    for (const file of files) void upload(file);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    addFiles(event.dataTransfer.files);
  }

  return (
    <div className="grid gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-testid="design-upload-drop"
        className={cn(
          'grid justify-items-center gap-2 rounded-xl border-2 border-dashed p-4 text-center text-xs text-muted-foreground',
          dragOver && 'border-primary bg-primary/5',
        )}
      >
        <UploadIcon className="size-6" aria-hidden />
        <span>{tUploads('drop')}</span>
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
        >
          {tUploads('pick')}
        </label>
        <input
          id={inputId}
          type="file"
          accept={DESIGN_ASSET_MIME_TYPES.join(',')}
          multiple
          className="sr-only"
          onChange={(e) => {
            addFiles(e.target.files ?? []);
            e.target.value = '';
          }}
        />
        <span>{tUploads('hint', { max: formatBytes(limits.assetMaxBytes) })}</span>
      </div>

      {uploads.map((u) => (
        <div key={u.key} className="grid gap-1 rounded-lg border p-2 text-xs" role="status">
          <span className="flex items-center gap-2">
            {u.status === 'failed' ? null : (
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            )}
            <span className="truncate font-medium">{u.name}</span>
          </span>
          <span
            className={cn(u.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
          >
            {u.status === 'failed' ? `${tUploads('failed')}: ${u.error ?? ''}` : tUploads(u.status)}
          </span>
        </div>
      ))}

      {images.length === 0 && uploads.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tUploads('empty')}</p>
      ) : (
        <ul aria-label={tUploads('listLabel')} className="grid grid-cols-2 gap-2">
          {images.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                disabled={a.status !== 'ready'}
                onClick={() => dispatch({ type: 'add', element: makeImage(a.id, a) })}
                aria-label={tUploads('add')}
                className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border bg-[conic-gradient(#eee_25%,#fff_0_50%,#eee_0_75%,#fff_0)] bg-[length:12px_12px] hover:border-primary"
              >
                {a.url !== null ? (
                  // Signed CDN URL of the design image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.url} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <LoaderCircleIcon
                    className="size-5 animate-spin text-muted-foreground"
                    aria-hidden
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PRESET_COLORS = [
  '#ffffff',
  '#f5f5f4',
  '#111827',
  '#0a0a0a',
  '#fde2f3',
  '#e0e7ff',
  '#d1fae5',
  '#fef3c7',
  '#0e4db3',
  '#e11d2e',
];

const PRESET_GRADIENTS: Extract<DesignBackground, { type: 'gradient' }>[] = [
  {
    type: 'gradient',
    angle: 180,
    stops: [
      { color: '#f5f6f8', at: 0 },
      { color: '#e6e9ef', at: 1 },
    ],
  },
  {
    type: 'gradient',
    angle: 160,
    stops: [
      { color: '#fde2f3', at: 0 },
      { color: '#e0e7ff', at: 0.55 },
      { color: '#d1fae5', at: 1 },
    ],
  },
  {
    type: 'gradient',
    angle: 180,
    stops: [
      { color: '#0b0b1a', at: 0 },
      { color: '#2a1b3d', at: 1 },
    ],
  },
  {
    type: 'gradient',
    angle: 135,
    stops: [
      { color: '#0a1f44', at: 0 },
      { color: '#0e4db3', at: 0.55 },
      { color: '#22d3ee', at: 1 },
    ],
  },
  {
    type: 'gradient',
    angle: 135,
    stops: [
      { color: '#f97316', at: 0 },
      { color: '#db2777', at: 1 },
    ],
  },
  {
    type: 'gradient',
    angle: 90,
    stops: [
      { color: '#10b981', at: 0 },
      { color: '#3b82f6', at: 1 },
    ],
  },
];

function BackgroundPanel() {
  const tBg = useTranslations('designs.editor.background');
  const { state, dispatch, swatches } = useEditor();
  const images = useImageList().filter((a) => a.status === 'ready');
  const bg = state.doc.background;
  const set = (background: DesignBackground, coalesce?: string) =>
    dispatch({ type: 'background', background, coalesce });
  const end = () => dispatch({ type: 'endGesture' });
  const baseColor = bg.type === 'gradient' ? (bg.stops[0]?.color ?? '#ffffff') : bg.color;

  return (
    <div className="grid gap-4">
      <div
        role="radiogroup"
        aria-label={tBg('type')}
        className="grid grid-cols-3 gap-1 rounded-lg border p-1 text-xs"
      >
        {(['color', 'gradient', 'image'] as const).map((type) => (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={bg.type === type}
            className={cn(
              'rounded-md px-2 py-1.5 disabled:opacity-50',
              bg.type === type ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
            onClick={() => {
              if (bg.type === type) return;
              if (type === 'color') set({ type: 'color', color: baseColor });
              else if (type === 'gradient') set(PRESET_GRADIENTS[0] as DesignBackground);
              else if (images[0] !== undefined) {
                set({ type: 'image', assetId: images[0].id, blur: 0, dim: 0, color: baseColor });
              }
            }}
            // An image background needs an uploaded image (the Uploads tab).
            disabled={type === 'image' && images.length === 0 && bg.type !== 'image'}
          >
            {tBg(type)}
          </button>
        ))}
      </div>

      {images.length === 0 && bg.type !== 'image' ? (
        <p className="text-xs text-muted-foreground">{tBg('noImages')}</p>
      ) : null}

      <div className="grid gap-2">
        <span className="text-xs font-medium text-muted-foreground">{tBg('presets')}</span>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              title={c}
              className="size-7 rounded-md border"
              style={{ background: c }}
              onClick={() => set({ type: 'color', color: c })}
            />
          ))}
          {PRESET_GRADIENTS.map((g, i) => (
            <button
              key={`g${i}`}
              type="button"
              aria-label={`${tBg('gradient')} ${i + 1}`}
              className="size-7 rounded-md border"
              style={{
                background: `linear-gradient(${g.angle}deg, ${g.stops.map((s) => `${s.color} ${s.at * 100}%`).join(', ')})`,
              }}
              onClick={() => set(g)}
            />
          ))}
        </div>
      </div>

      {bg.type === 'color' ? (
        <ColorField
          label={tBg('color')}
          value={bg.color}
          swatches={swatches}
          onChange={(color) => set({ type: 'color', color }, 'bg-color')}
          onCommit={end}
        />
      ) : null}

      {bg.type === 'gradient' ? (
        <div className="grid gap-3">
          <SliderField
            label={tBg('angle')}
            value={bg.angle}
            min={0}
            max={360}
            onChange={(angle) => set({ ...bg, angle }, 'bg-angle')}
            onCommit={end}
            format={(v) => `${v}°`}
          />
          {bg.stops.map((stop, i) => (
            <div key={i} className="grid gap-2 rounded-lg border p-2">
              <ColorField
                label={tBg('stop', { n: i + 1 })}
                value={stop.color}
                swatches={swatches}
                onChange={(color) =>
                  set(
                    { ...bg, stops: bg.stops.map((s, j) => (j === i ? { ...s, color } : s)) },
                    `bg-stop-${i}`,
                  )
                }
                onCommit={end}
              />
              <SliderField
                label="%"
                value={Math.round(stop.at * 100)}
                min={Math.round((bg.stops[i - 1]?.at ?? 0) * 100)}
                max={Math.round((bg.stops[i + 1]?.at ?? 1) * 100)}
                onChange={(v) =>
                  set(
                    { ...bg, stops: bg.stops.map((s, j) => (j === i ? { ...s, at: v / 100 } : s)) },
                    `bg-at-${i}`,
                  )
                }
                onCommit={end}
                format={(v) => `${v}%`}
              />
            </div>
          ))}
        </div>
      ) : null}

      {bg.type === 'image' ? (
        <div className="grid gap-3">
          <span className="text-xs font-medium text-muted-foreground">{tBg('chooseImage')}</span>
          {images.length === 0 ? (
            <Alert variant="default" className="text-xs">
              {tBg('noImages')}
            </Alert>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {images.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={bg.assetId === a.id}
                  aria-label={tBg('chooseImage')}
                  onClick={() => set({ ...bg, assetId: a.id })}
                  className={cn(
                    'aspect-square overflow-hidden rounded-md border',
                    bg.assetId === a.id && 'ring-2 ring-primary',
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url ?? ''} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <SliderField
            label={tBg('blur')}
            value={bg.blur}
            min={0}
            max={40}
            onChange={(blur) => set({ ...bg, blur }, 'bg-blur')}
            onCommit={end}
          />
          <SliderField
            label={tBg('dim')}
            value={Math.round(bg.dim * 100)}
            min={0}
            max={80}
            onChange={(v) => set({ ...bg, dim: v / 100 }, 'bg-dim')}
            onCommit={end}
            format={(v) => `${v}%`}
          />
          <ColorField
            label={tBg('color')}
            value={bg.color}
            swatches={swatches}
            onChange={(color) => set({ ...bg, color }, 'bg-color')}
            onCommit={end}
          />
        </div>
      ) : null}
    </div>
  );
}

const TYPE_ICONS: Record<DesignElement['type'], typeof TypeIcon> = {
  text: TypeIcon,
  image: ImageIcon,
  shape: SquareIcon,
  faceIcon: ScanFaceIcon,
  scanButtons: ScanFaceIcon,
  helpButton: CircleHelpIcon,
};

/** A short name of an element for Layers: its text, else its type. */
export function useLayerName(): (e: DesignElement) => string {
  const tTypes = useTranslations('designs.editor.layers.types');
  return (e) =>
    e.type === 'text' && e.text.trim() !== '' ? e.text.trim().slice(0, 40) : tTypes(e.type);
}

function LayersPanel() {
  const tLayers = useTranslations('designs.editor.layers');
  const { state, dispatch } = useEditor();
  const name = useLayerName();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // Top layer first.
  const rows = [...state.doc.elements].reverse();
  const count = rows.length;

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{tLayers('dragHint')}</p>
      <ul aria-label={tLayers('label')} className="grid gap-1">
        {rows.map((e, row) => {
          const Icon = TYPE_ICONS[e.type];
          const selected = state.selection.includes(e.id);
          const label = name(e);
          return (
            <li
              key={e.id}
              draggable
              onDragStart={(event) => {
                setDragging(e.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', e.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(row);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragging ?? event.dataTransfer.getData('text/plain');
                // Row r (top first) is document index count - 1 - r.
                if (id !== '') dispatch({ type: 'moveLayer', id, toIndex: count - 1 - row });
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                'flex items-center gap-1 rounded-md border bg-background px-1 py-1 text-xs',
                selected && 'border-primary bg-primary/5',
                over === row && dragging !== e.id && 'ring-2 ring-primary/50',
                e.hidden && 'opacity-60',
              )}
            >
              <GripVerticalIcon
                className="size-4 shrink-0 cursor-grab text-muted-foreground"
                aria-hidden
              />
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                aria-pressed={selected}
                onClick={(event) =>
                  dispatch({ type: 'select', ids: [e.id], additive: event.shiftKey })
                }
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                className="rounded p-1 hover:bg-muted"
                aria-label={
                  e.locked ? tLayers('unlock', { name: label }) : tLayers('lock', { name: label })
                }
                aria-pressed={e.locked}
                onClick={() => dispatch({ type: 'toggleLock', ids: [e.id] })}
              >
                {e.locked ? (
                  <LockIcon className="size-3.5" aria-hidden />
                ) : (
                  <UnlockIcon className="size-3.5 text-muted-foreground" aria-hidden />
                )}
              </button>
              <button
                type="button"
                className="rounded p-1 hover:bg-muted disabled:opacity-30"
                aria-label={
                  e.hidden ? tLayers('show', { name: label }) : tLayers('hide', { name: label })
                }
                aria-pressed={e.hidden}
                // The face icon and the scan buttons always show (they can only be unhidden).
                disabled={!isDeletable(e) && !e.hidden}
                onClick={() => dispatch({ type: 'toggleHidden', id: e.id })}
              >
                {e.hidden ? (
                  <EyeOffIcon className="size-3.5" aria-hidden />
                ) : (
                  <EyeIcon className="size-3.5 text-muted-foreground" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
