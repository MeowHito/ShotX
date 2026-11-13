'use client';

import { Alert, Button, Checkbox, cn, Label } from '@shotx/ui';
import { ImageUpIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  WATERMARK_POSITIONS,
  type WatermarkSettings,
} from '@/lib/sync/store';
import { watermarkBox } from '@/lib/sync/watermark';
import { useFolderSync } from './folder-sync-context';

/** Largest watermark image accepted (a logo; the mark is decoded once per sync). */
export const WATERMARK_MAX_BYTES = 5 * 1024 * 1024;
const WATERMARK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const DEFAULTS = {
  position: 'bottom-right',
  sizePercent: 20,
  opacityPercent: 80,
  marginPercent: 3,
} as const;

type Draft = Omit<WatermarkSettings, 'image'> & { image: Blob | null };

function draftOf(saved: WatermarkSettings | null): Draft {
  return saved ?? { enabled: true, image: null, ...DEFAULTS };
}

/**
 * ADR 0021: the folder sync's watermark. The photographer picks an image (PNG with transparency
 * works best), its position on a 3×3 grid, its size, opacity and margin, sees it on a landscape
 * and a portrait frame, and saves. Saved settings apply to photos synced from then on.
 */
export function WatermarkCard() {
  const t = useTranslations('folderSync.watermark');
  const id = useId();
  const { watermark, saveWatermark } = useFolderSync();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // The saved settings arrive from IndexedDB once; editing starts from them.
  const current = draft ?? (watermark === undefined ? null : draftOf(watermark));
  if (current === null) return null;
  const edit = (change: Partial<Draft>) => {
    setNotice(null);
    setDraft({ ...current, ...change });
  };

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    if (!WATERMARK_TYPES.includes(file.type)) {
      setNotice({ kind: 'error', text: t('badType') });
      return;
    }
    if (file.size > WATERMARK_MAX_BYTES) {
      setNotice({ kind: 'error', text: t('tooLarge', { mb: WATERMARK_MAX_BYTES / 1024 / 1024 }) });
      return;
    }
    edit({ image: file, enabled: true });
  }

  async function save() {
    if (current === null || current.image === null) return;
    setSaving(true);
    try {
      await saveWatermark({ ...current, image: current.image });
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

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={WATERMARK_TYPES.join(',')}
          className="sr-only"
          aria-label={t('choose')}
          onChange={pick}
        />
        <Button type="button" variant="outline" onClick={() => input.current?.click()}>
          <ImageUpIcon aria-hidden />
          {current.image === null ? t('choose') : t('change')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('chooseHint')}</span>
      </div>

      {current.image !== null ? (
        <>
          <div className="flex items-start gap-3">
            <Checkbox
              id={`${id}-on`}
              checked={current.enabled}
              onCheckedChange={(v) => edit({ enabled: v === true })}
            />
            <Label htmlFor={`${id}-on`}>{t('enabled')}</Label>
          </div>

          <Preview draft={{ ...current, image: current.image }} label={t('preview')} />

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
            max={60}
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

/** The mark on a landscape (3:2) and a portrait (2:3) frame, placed like the photos will be. */
function Preview({ draft, label }: { draft: WatermarkSettings; label: string }) {
  const url = useMemo(() => URL.createObjectURL(draft.image), [draft.image]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const frames = [
    { width: 240, height: 160 },
    { width: 120, height: 180 },
  ];
  return (
    <figure className="space-y-1">
      <div className="flex flex-wrap items-end gap-3" role="img" aria-label={label}>
        {/* Natural size of the mark, for its aspect ratio. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          className="hidden"
          onLoad={(e) =>
            setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
          }
        />
        {frames.map((frame) => {
          const box = watermarkBox(frame, size ?? { width: 1, height: 1 }, draft);
          return (
            <div
              key={`${frame.width}x${frame.height}`}
              className="relative overflow-hidden rounded-md bg-gradient-to-br from-sky-300 via-sky-500 to-indigo-600"
              style={{ width: frame.width, height: frame.height }}
            >
              {size !== null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt=""
                  className="absolute"
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
