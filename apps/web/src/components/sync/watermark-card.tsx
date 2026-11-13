'use client';

import { Alert, Button, Checkbox, cn, Label } from '@shotx/ui';
import { FrameIcon, ImageUpIcon, StampIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { WATERMARK_MODES, WATERMARK_POSITIONS, type WatermarkSettings } from '@/lib/sync/store';
import { trimmedMark, watermarkBox } from '@/lib/sync/watermark';
import { useFolderSync } from './folder-sync-context';

/** Largest watermark image accepted (a logo; the mark is decoded once per sync). */
export const WATERMARK_MAX_BYTES = 5 * 1024 * 1024;
/** ADR 0022: largest frame image (a full-photo PNG is bigger than a logo). */
export const FRAME_MAX_BYTES = 15 * 1024 * 1024;
const WATERMARK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const DEFAULTS = {
  mode: 'logo',
  position: 'bottom-right',
  sizePercent: 20,
  opacityPercent: 80,
  marginPercent: 3,
} as const;

type Draft = WatermarkSettings;
type ImageSlot = 'image' | 'frameLandscape' | 'framePortrait';

function draftOf(saved: WatermarkSettings | null): Draft {
  return (
    saved ?? { enabled: true, image: null, frameLandscape: null, framePortrait: null, ...DEFAULTS }
  );
}

/** Whether the settings have the image(s) their mode needs. */
function hasImage(d: Draft): boolean {
  return d.mode === 'frame'
    ? d.frameLandscape !== null || d.framePortrait !== null
    : d.image !== null;
}

/**
 * ADR 0021: the folder sync's watermark. The photographer picks an image (PNG with transparency
 * works best), its position on a 3×3 grid, its size, opacity and margin, sees it on a landscape
 * and a portrait frame, and saves. Saved settings apply to photos synced from then on.
 * ADR 0022: or the frame mode, with one frame image for landscape and one for portrait photos.
 */
export function WatermarkCard() {
  const t = useTranslations('folderSync.watermark');
  const id = useId();
  const { watermark, saveWatermark } = useFolderSync();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // The saved settings arrive from IndexedDB once; editing starts from them.
  const current = draft ?? (watermark === undefined ? null : draftOf(watermark));
  if (current === null) return null;
  const edit = (change: Partial<Draft>) => {
    setNotice(null);
    setDraft({ ...current, ...change });
  };

  function pick(slot: ImageSlot, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    if (!WATERMARK_TYPES.includes(file.type)) {
      setNotice({ kind: 'error', text: t('badType') });
      return;
    }
    const max = slot === 'image' ? WATERMARK_MAX_BYTES : FRAME_MAX_BYTES;
    if (file.size > max) {
      setNotice({ kind: 'error', text: t('tooLarge', { mb: max / 1024 / 1024 }) });
      return;
    }
    edit({ [slot]: file, enabled: true });
  }

  async function save() {
    if (current === null || !hasImage(current)) return;
    setSaving(true);
    try {
      await saveWatermark(current);
      setDraft(null);
      setNotice({ kind: 'info', text: current.enabled ? t('saved') : t('savedOff') });
    } catch {
      setNotice({ kind: 'error', text: t('saveFailed') });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await saveWatermark(null);
      setDraft(null);
      setNotice({ kind: 'info', text: t('removed') });
    } catch {
      setNotice({ kind: 'error', text: t('saveFailed') });
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft !== null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-xl border bg-background p-4 md:p-5"
    >
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {notice !== null ? (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
          {notice.text}
        </Alert>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('mode')}</legend>
        <div className="inline-flex rounded-lg border p-1" role="radiogroup" aria-label={t('mode')}>
          {WATERMARK_MODES.map((m) => {
            const Icon = m === 'logo' ? StampIcon : FrameIcon;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={current.mode === m}
                onClick={() => edit({ mode: m })}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                  current.mode === m
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {t(`modes.${m}`)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t(`modeHints.${current.mode}`)}</p>
      </fieldset>

      {current.mode === 'logo' ? (
        <ImagePicker
          label={current.image === null ? t('choose') : t('change')}
          inputLabel={t('choose')}
          hint={t('chooseHint')}
          onChange={(e) => pick('image', e)}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(['frameLandscape', 'framePortrait'] as const).map((slot) => (
            <div key={slot} className="space-y-1.5 rounded-lg border p-3">
              <p className="text-sm font-medium">{t(`frames.${slot}`)}</p>
              <ImagePicker
                label={current[slot] === null ? t('frames.choose') : t('frames.change')}
                inputLabel={t(`frames.${slot}`)}
                hint={current[slot] === null ? t('frames.missing') : t('frames.ready')}
                onChange={(e) => pick(slot, e)}
              />
              {current[slot] !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => edit({ [slot]: null })}
                >
                  <Trash2Icon aria-hidden />
                  {t('frames.remove')}
                </Button>
              ) : null}
            </div>
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('frames.hint')}</p>
        </div>
      )}

      {hasImage(current) ? (
        <>
          <div className="flex items-start gap-3">
            <Checkbox
              id={`${id}-on`}
              checked={current.enabled}
              onCheckedChange={(v) => edit({ enabled: v === true })}
            />
            <Label htmlFor={`${id}-on`}>{t('enabled')}</Label>
          </div>

          {current.mode === 'logo' && current.image !== null ? (
            <>
              <LogoPreview draft={current} image={current.image} label={t('preview')} />

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t('position')}</legend>
                <div className="grid w-36 grid-cols-3 gap-1">
                  {WATERMARK_POSITIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-label={t(`positions.${p}`)}
                      aria-pressed={current.position === p}
                      onClick={() => edit({ position: p })}
                      className={cn(
                        'flex aspect-square items-center justify-center rounded-md border transition-colors',
                        current.position === p
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'hover:bg-accent',
                      )}
                    >
                      <span className="size-2 rounded-full bg-current" aria-hidden />
                    </button>
                  ))}
                </div>
              </fieldset>

              <Slider
                id={`${id}-size`}
                label={t('size')}
                value={current.sizePercent}
                min={5}
                max={100}
                onChange={(v) => edit({ sizePercent: v })}
              />
              <Slider
                id={`${id}-opacity`}
                label={t('opacity')}
                value={current.opacityPercent}
                min={10}
                max={100}
                onChange={(v) => edit({ opacityPercent: v })}
              />
              <Slider
                id={`${id}-margin`}
                label={t('margin')}
                value={current.marginPercent}
                min={0}
                max={10}
                onChange={(v) => edit({ marginPercent: v })}
              />
            </>
          ) : null}

          {current.mode === 'frame' ? (
            <FramePreview
              landscape={current.frameLandscape}
              portrait={current.framePortrait}
              label={t('preview')}
              missing={t('frames.none')}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">{t('note')}</p>

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save()} disabled={saving || !dirty}>
              {t('save')}
            </Button>
            {watermark != null ? (
              <Button type="button" variant="ghost" onClick={() => void remove()} disabled={saving}>
                <Trash2Icon aria-hidden />
                {t('remove')}
              </Button>
            ) : null}
            {dirty ? (
              <span className="self-center text-xs text-muted-foreground">{t('unsaved')}</span>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid max-w-sm gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <Label htmlFor={id}>{label}</Label>
        <span className="tabular-nums text-muted-foreground">{value}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

function ImagePicker({
  label,
  inputLabel,
  hint,
  onChange,
}: {
  label: string;
  inputLabel: string;
  hint: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={WATERMARK_TYPES.join(',')}
        className="sr-only"
        aria-label={inputLabel}
        onChange={onChange}
      />
      <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
        <ImageUpIcon aria-hidden />
        {label}
      </Button>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/** An object URL for `blob`, revoked when it changes or the component goes away. */
function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob === null ? null : URL.createObjectURL(blob)), [blob]);
  useEffect(() => () => (url === null ? undefined : URL.revokeObjectURL(url)), [url]);
  return url;
}

/**
 * The logo as the sync draws it: trimmed to its visible pixels (ADR 0022). Falls back to the
 * image as chosen where the browser can't trim (no OffscreenCanvas).
 */
function useTrimmedUrl(image: Blob): string | null {
  const raw = useObjectUrl(image);
  const [trimmed, setTrimmed] = useState<{ for: Blob; url: string } | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    (async () => {
      const bitmap = await trimmedMark(image);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (!live) return;
      made = URL.createObjectURL(blob);
      setTrimmed({ for: image, url: made });
    })().catch(() => undefined);
    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [image]);
  return trimmed?.for === image ? trimmed.url : raw;
}

const PREVIEW_FRAMES = [
  { width: 300, height: 200 },
  { width: 150, height: 225 },
];

/** The logo on a landscape (3:2) and a portrait (2:3) frame, placed like the photos will be. */
function LogoPreview({ draft, image, label }: { draft: Draft; image: Blob; label: string }) {
  const url = useTrimmedUrl(image);
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const natural = size !== null && size.url === url ? size : null;
  return (
    <figure className="space-y-1">
      <div className="flex flex-wrap items-end gap-3" role="img" aria-label={label}>
        {url !== null ? (
          // Natural size of the (trimmed) mark, for its aspect ratio.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            className="hidden"
            onLoad={(e) =>
              setSize({
                url,
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
          />
        ) : null}
        {PREVIEW_FRAMES.map((frame) => {
          const box = watermarkBox(frame, natural ?? { width: 1, height: 1 }, draft);
          return (
            <div
              key={`${frame.width}x${frame.height}`}
              className="relative max-w-full shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-sky-300 via-sky-500 to-indigo-600"
              style={{ width: frame.width, height: frame.height }}
            >
              {natural !== null && url !== null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt=""
                  className="absolute max-w-none"
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.width,
                    height: box.height,
                    opacity: draft.opacityPercent / 100,
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

/** ADR 0022: each frame stretched over a photo of its orientation, as the sync draws it. */
function FramePreview({
  landscape,
  portrait,
  label,
  missing,
}: {
  landscape: Blob | null;
  portrait: Blob | null;
  label: string;
  missing: string;
}) {
  const urls = [useObjectUrl(landscape), useObjectUrl(portrait)];
  return (
    <figure className="space-y-1">
      <div className="flex flex-wrap items-end gap-3" role="img" aria-label={label}>
        {PREVIEW_FRAMES.map((frame, i) => {
          const url = urls[i] ?? null;
          return (
            <div
              key={`${frame.width}x${frame.height}`}
              className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-sky-300 via-sky-500 to-indigo-600"
              style={{ width: frame.width, height: frame.height }}
            >
              {url !== null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt="" className="absolute inset-0 size-full max-w-none" />
              ) : (
                <span className="px-2 text-center text-xs text-white/90">{missing}</span>
              )}
            </div>
          );
        })}
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
