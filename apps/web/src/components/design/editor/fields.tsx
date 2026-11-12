'use client';

import { DESIGN_COLOR_PATTERN, type DesignColor } from '@shotx/shared';
import { cn, Popover, PopoverContent, PopoverTrigger } from '@shotx/ui';
import { BanIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type CSSProperties, type ReactNode, useId, useState } from 'react';

/**
 * Small inputs of the designer's panels. Each change is sent as it happens with a `gesture` key
 * (so a slider drag or typing in a number is one undo step) and `onCommit` ends the step.
 */

export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/** A number input: shows the value rounded, sends finite numbers only, clamps on commit. */
export function NumberField({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  className,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  min: number;
  max: number;
  step?: number;
  className?: string;
}) {
  const id = useId();
  const shown = String(Math.round(value * 100) / 100);
  // What is typed while focused; otherwise the value itself.
  const [text, setText] = useState<string | null>(null);
  return (
    <Field label={label} htmlFor={id} className={className}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-sm tabular-nums"
        value={text ?? shown}
        min={min}
        max={max}
        step={step}
        onFocus={() => setText(shown)}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number.parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        onBlur={() => {
          setText(null);
          onCommit?.();
        }}
      />
    </Field>
  );
}

/** A range slider with its value. */
export function SliderField({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  format = (v) => String(Math.round(v * 100) / 100),
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-xs">
        <label htmlFor={id} className="font-medium text-muted-foreground">
          {label}
        </label>
        <span className="tabular-nums">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="w-full accent-primary"
      />
    </div>
  );
}

export function ToggleButton({
  pressed,
  onClick,
  label,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm transition-colors',
        pressed ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

/** `#rrggbb` and an alpha 0..1 of a document colour. */
function splitColor(color: DesignColor): { hex: string; alpha: number } {
  const hex = color.slice(0, 7).toLowerCase();
  const alpha = color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
  return { hex, alpha };
}

function joinColor(hex: string, alpha: number): DesignColor {
  if (alpha >= 1) return hex.toLowerCase();
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.toLowerCase()}${a}`;
}

/**
 * A colour of the document: a swatch that opens a picker (the system colour picker, a hex field,
 * opacity, and the colours already used in the design). `nullable` adds "no colour".
 */
export function ColorField<N extends boolean = false>({
  label,
  value,
  onChange,
  onCommit,
  swatches,
  nullable,
}: {
  label: string;
  value: N extends true ? DesignColor | null : DesignColor;
  onChange: (value: N extends true ? DesignColor | null : DesignColor) => void;
  onCommit?: () => void;
  swatches: readonly DesignColor[];
  nullable?: N;
}) {
  const t = useTranslations('designs.editor.props');
  const id = useId();
  const current = value === null ? null : splitColor(value);
  // What is typed in the hex field while it is focused; otherwise the value itself.
  const [hexText, setHexText] = useState<string | null>(null);
  const set = (next: DesignColor | null) => (onChange as (v: DesignColor | null) => void)(next);

  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground" id={`${id}-label`}>
        {label}
      </span>
      <Popover onOpenChange={(open) => (open ? undefined : onCommit?.())}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-labelledby={`${id}-label`}
            className="flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-left text-xs"
          >
            <span
              className="size-5 shrink-0 rounded border bg-[conic-gradient(#ddd_25%,#fff_0_50%,#ddd_0_75%,#fff_0)] bg-[length:8px_8px]"
              aria-hidden
            >
              <span
                className="block size-full rounded"
                style={{ background: value ?? 'transparent' }}
              >
                {value === null ? (
                  <BanIcon className="size-full p-0.5 text-muted-foreground" />
                ) : null}
              </span>
            </span>
            <span className="truncate font-mono">{value ?? t('noColor')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-64 gap-3 p-3">
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={label}
              value={current?.hex ?? '#000000'}
              onChange={(e) => set(joinColor(e.target.value, current?.alpha ?? 1))}
              className="h-9 w-12 cursor-pointer rounded border bg-background"
            />
            <input
              aria-label={t('hex')}
              value={hexText ?? value ?? ''}
              onFocus={() => setHexText(value ?? '')}
              onBlur={() => setHexText(null)}
              onChange={(e) => {
                const text = e.target.value.trim();
                setHexText(text);
                const normalized = text.startsWith('#') ? text : `#${text}`;
                if (DESIGN_COLOR_PATTERN.test(normalized)) set(normalized.toLowerCase());
              }}
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-sm"
              maxLength={9}
              spellCheck={false}
            />
          </div>
          {current !== null ? (
            <SliderField
              label={t('opacity')}
              value={Math.round(current.alpha * 100)}
              min={0}
              max={100}
              onChange={(v) => set(joinColor(current.hex, v / 100))}
              format={(v) => `${v}%`}
            />
          ) : null}
          {swatches.length > 0 || nullable ? (
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">{t('swatches')}</span>
              <div className="flex flex-wrap gap-1.5">
                {nullable ? (
                  <button
                    type="button"
                    onClick={() => set(null)}
                    aria-label={t('noColor')}
                    title={t('noColor')}
                    className="flex size-7 items-center justify-center rounded border"
                  >
                    <BanIcon className="size-4 text-muted-foreground" aria-hidden />
                  </button>
                ) : null}
                {swatches.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set(c)}
                    aria-label={c}
                    title={c}
                    className={cn(
                      'size-7 rounded border',
                      value?.toLowerCase() === c && 'ring-2 ring-primary ring-offset-1',
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function SelectField<V extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string; style?: CSSProperties }[];
  onChange: (value: V) => void;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked !== undefined) onChange(picked.value);
        }}
        className="h-8 w-full rounded-md border bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} style={o.style}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
