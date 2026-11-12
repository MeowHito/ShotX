'use client';

import {
  DESIGN_COORDINATE_RANGE,
  DESIGN_FONT_INFO,
  DESIGN_FONTS,
  DESIGN_REQUIRED_ELEMENT_MIN_OPACITY,
  DESIGN_SIZE_RANGE,
  type DesignColor,
  type DesignElement,
  type DesignElementOf,
} from '@shotx/shared';
import { Button } from '@shotx/ui';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CaseUpperIcon,
  CopyIcon,
  FlipHorizontalIcon,
  ItalicIcon,
  LockIcon,
  Trash2Icon,
  UnlockIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { selectedElements } from '@/lib/design/editor-state';
import { isDeletable } from '@/lib/design/elements';
import { designFontFamily, designFontLabel } from '@/lib/design/fonts';
import { useEditor } from './editor-context';
import { ColorField, NumberField, SelectField, SliderField, ToggleButton } from './fields';

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-b pb-3">
      {title !== undefined ? <h3 className="text-xs font-semibold">{title}</h3> : null}
      {children}
    </section>
  );
}

/**
 * The right side of the designer: properties of the selection. One element: position, size,
 * rotation, opacity and its type's own style; several: what they share (order, lock, opacity,
 * duplicate, delete). The face icon and the scan buttons have no delete.
 */
export function PropertiesPanel() {
  const t = useTranslations('designs.editor.props');
  const { state, dispatch } = useEditor();
  const selected = selectedElements(state);
  const single = selected.length === 1 ? (selected[0] as DesignElement) : null;

  return (
    <aside
      className="flex h-full min-h-0 w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-sidebar p-3"
      aria-label={t('title')}
    >
      <h2 className="text-sm font-semibold">{t('title')}</h2>
      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('none')}</p>
      ) : (
        <>
          {single === null ? (
            <p className="text-xs text-muted-foreground">
              {t('multiple', { count: selected.length })}
            </p>
          ) : (
            <ElementProperties key={single.id} element={single} />
          )}
          <Section title={t('order')}>
            <div className="grid grid-cols-4 gap-1">
              <ToggleButton
                pressed={false}
                label={t('forward')}
                onClick={() => dispatch({ type: 'order', move: 'forward' })}
              >
                <ArrowUpIcon className="size-4" aria-hidden />
              </ToggleButton>
              <ToggleButton
                pressed={false}
                label={t('backward')}
                onClick={() => dispatch({ type: 'order', move: 'backward' })}
              >
                <ArrowDownIcon className="size-4" aria-hidden />
              </ToggleButton>
              <ToggleButton
                pressed={false}
                label={t('front')}
                onClick={() => dispatch({ type: 'order', move: 'front' })}
              >
                <ArrowUpToLineIcon className="size-4" aria-hidden />
              </ToggleButton>
              <ToggleButton
                pressed={false}
                label={t('back')}
                onClick={() => dispatch({ type: 'order', move: 'back' })}
              >
                <ArrowDownToLineIcon className="size-4" aria-hidden />
              </ToggleButton>
            </div>
          </Section>
          <div className="flex flex-wrap gap-2">
            {(() => {
              const locked = selected.every((e) => e.locked);
              return (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => dispatch({ type: 'toggleLock' })}
                >
                  {locked ? <UnlockIcon aria-hidden /> : <LockIcon aria-hidden />}
                  {locked ? t('unlock') : t('lock')}
                </Button>
              );
            })()}
            <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'duplicate' })}>
              <CopyIcon aria-hidden />
              {t('duplicate')}
            </Button>
            {selected.some(isDeletable) ? (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => dispatch({ type: 'delete' })}
              >
                <Trash2Icon aria-hidden />
                {t('delete')}
              </Button>
            ) : null}
          </div>
          {selected.some((e) => !isDeletable(e)) ? (
            <p className="text-xs text-muted-foreground">{t('cantDelete')}</p>
          ) : null}
        </>
      )}
    </aside>
  );
}

function ElementProperties({ element: e }: { element: DesignElement }) {
  const t = useTranslations('designs.editor.props');
  const { dispatch } = useEditor();
  const key = (field: string) => `prop-${e.id}-${field}`;
  const update = (patch: Partial<DesignElement>, field: string) =>
    dispatch({ type: 'update', changes: { [e.id]: patch }, coalesce: key(field) });
  const end = () => dispatch({ type: 'endGesture' });
  const coord = DESIGN_COORDINATE_RANGE;
  const size = DESIGN_SIZE_RANGE;

  return (
    <>
      <Section>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('x')}
            value={e.x}
            min={coord.min}
            max={coord.max}
            onChange={(x) => update({ x }, 'x')}
            onCommit={end}
          />
          <NumberField
            label={t('y')}
            value={e.y}
            min={coord.min}
            max={coord.max}
            onChange={(y) => update({ y }, 'y')}
            onCommit={end}
          />
          <NumberField
            label={t('w')}
            value={e.w}
            min={size.min}
            max={size.max}
            onChange={(w) => update({ w }, 'w')}
            onCommit={end}
          />
          {e.type === 'scanButtons' ? null : (
            <NumberField
              label={t('h')}
              value={e.h}
              min={size.min}
              max={size.max}
              onChange={(h) => update({ h }, 'h')}
              onCommit={end}
            />
          )}
          <NumberField
            label={t('rotation')}
            value={e.rotation}
            min={-180}
            max={180}
            onChange={(rotation) => update({ rotation }, 'rotation')}
            onCommit={end}
          />
        </div>
        <SliderField
          label={t('opacity')}
          value={Math.round(e.opacity * 100)}
          min={isDeletable(e) ? 0 : Math.round(DESIGN_REQUIRED_ELEMENT_MIN_OPACITY * 100)}
          max={100}
          onChange={(v) => update({ opacity: v / 100 }, 'opacity')}
          onCommit={end}
          format={(v) => `${v}%`}
        />
      </Section>
      {e.type === 'text' ? <TextProperties e={e} update={update} end={end} /> : null}
      {e.type === 'shape' ? <ShapeProperties e={e} update={update} end={end} /> : null}
      {e.type === 'image' ? <ImageProperties e={e} update={update} end={end} /> : null}
      {e.type === 'faceIcon' ? <FaceIconProperties e={e} update={update} end={end} /> : null}
      {e.type === 'scanButtons' ? <ScanButtonsProperties e={e} update={update} end={end} /> : null}
      {e.type === 'helpButton' ? <HelpButtonProperties e={e} update={update} end={end} /> : null}
    </>
  );
}

interface TypeProps<T extends DesignElement['type']> {
  e: DesignElementOf<T>;
  update: (patch: Partial<DesignElement>, field: string) => void;
  end: () => void;
}

function useSwatches(): readonly DesignColor[] {
  return useEditor().swatches;
}

function TextProperties({ e, update, end }: TypeProps<'text'>) {
  const t = useTranslations('designs.editor.props');
  const swatches = useSwatches();
  const weights = DESIGN_FONT_INFO[e.font].weights;
  return (
    <Section>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
        {t('text')}
        <textarea
          value={e.text}
          maxLength={500}
          rows={3}
          onChange={(ev) => update({ text: ev.target.value }, 'text')}
          onBlur={end}
          className="rounded-md border bg-background p-2 text-sm font-normal text-foreground"
        />
      </label>
      <SelectField
        label={t('font')}
        value={e.font}
        options={DESIGN_FONTS.map((f) => ({
          value: f,
          label: designFontLabel(f),
          style: { fontFamily: designFontFamily(f) },
        }))}
        onChange={(font) => {
          // Keep the weight if the new font has it, else its nearest.
          const available = DESIGN_FONT_INFO[font].weights;
          const weight = available.reduce(
            (best, w) => (Math.abs(w - e.weight) < Math.abs(best - e.weight) ? w : best),
            available[0] ?? 400,
          );
          update({ font, weight }, 'font');
          end();
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={t('size')}
          value={e.size}
          min={8}
          max={200}
          onChange={(s) => update({ size: s }, 'size')}
          onCommit={end}
        />
        <SelectField
          label={t('weight')}
          value={e.weight}
          options={weights.map((w) => ({ value: w, label: String(w) }))}
          onChange={(weight) => {
            update({ weight }, 'weight');
            end();
          }}
        />
      </div>
      <ColorField
        label={t('color')}
        value={e.color}
        swatches={swatches}
        onChange={(color) => update({ color }, 'color')}
        onCommit={end}
      />
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('align')}>
        <ToggleButton
          pressed={e.align === 'left'}
          label={t('alignLeft')}
          onClick={() => {
            update({ align: 'left' }, 'align');
            end();
          }}
        >
          <AlignLeftIcon className="size-4" aria-hidden />
        </ToggleButton>
        <ToggleButton
          pressed={e.align === 'center'}
          label={t('alignCenter')}
          onClick={() => {
            update({ align: 'center' }, 'align');
            end();
          }}
        >
          <AlignCenterIcon className="size-4" aria-hidden />
        </ToggleButton>
        <ToggleButton
          pressed={e.align === 'right'}
          label={t('alignRight')}
          onClick={() => {
            update({ align: 'right' }, 'align');
            end();
          }}
        >
          <AlignRightIcon className="size-4" aria-hidden />
        </ToggleButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToggleButton
          pressed={e.italic}
          label={t('italic')}
          onClick={() => {
            update({ italic: !e.italic }, 'italic');
            end();
          }}
        >
          <ItalicIcon className="size-4" aria-hidden />
        </ToggleButton>
        <ToggleButton
          pressed={e.uppercase}
          label={t('uppercase')}
          onClick={() => {
            update({ uppercase: !e.uppercase }, 'uppercase');
            end();
          }}
        >
          <CaseUpperIcon className="size-4" aria-hidden />
        </ToggleButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={t('lineHeight')}
          value={e.lineHeight}
          min={0.8}
          max={3}
          step={0.05}
          onChange={(lineHeight) => update({ lineHeight }, 'lineHeight')}
          onCommit={end}
        />
        <NumberField
          label={t('letterSpacing')}
          value={e.letterSpacing}
          min={-5}
          max={50}
          step={0.5}
          onChange={(letterSpacing) => update({ letterSpacing }, 'letterSpacing')}
          onCommit={end}
        />
      </div>
      <label className="flex items-center gap-2 text-xs font-medium">
        <input
          type="checkbox"
          checked={e.shadow !== null}
          onChange={(ev) => {
            update(
              { shadow: ev.target.checked ? { color: '#00000080', blur: 8, x: 0, y: 2 } : null },
              'shadow',
            );
            end();
          }}
          className="size-4"
        />
        {t('shadow')}
      </label>
      {e.shadow !== null ? (
        <div className="grid gap-2 pl-6">
          <ColorField
            label={t('color')}
            value={e.shadow.color}
            swatches={swatches}
            onChange={(color) =>
              e.shadow && update({ shadow: { ...e.shadow, color } }, 'shadowColor')
            }
            onCommit={end}
          />
          <div className="grid grid-cols-3 gap-2">
            <NumberField
              label={t('shadowBlur')}
              value={e.shadow.blur}
              min={0}
              max={40}
              onChange={(blur) =>
                e.shadow && update({ shadow: { ...e.shadow, blur } }, 'shadowBlur')
              }
              onCommit={end}
            />
            <NumberField
              label={t('shadowX')}
              value={e.shadow.x}
              min={-50}
              max={50}
              onChange={(x) => e.shadow && update({ shadow: { ...e.shadow, x } }, 'shadowX')}
              onCommit={end}
            />
            <NumberField
              label={t('shadowY')}
              value={e.shadow.y}
              min={-50}
              max={50}
              onChange={(y) => e.shadow && update({ shadow: { ...e.shadow, y } }, 'shadowY')}
              onCommit={end}
            />
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function ShapeProperties({ e, update, end }: TypeProps<'shape'>) {
  const t = useTranslations('designs.editor.props');
  const swatches = useSwatches();
  return (
    <Section>
      {e.shape !== 'line' ? (
        <ColorField<true>
          label={t('fill')}
          value={e.fill}
          nullable
          swatches={swatches}
          onChange={(fill) => update({ fill }, 'fill')}
          onCommit={end}
        />
      ) : null}
      <ColorField<true>
        label={t('stroke')}
        value={e.stroke}
        nullable
        swatches={swatches}
        onChange={(stroke) => update({ stroke }, 'stroke')}
        onCommit={end}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={t('strokeWidth')}
          value={e.strokeWidth}
          min={0}
          max={40}
          step={0.5}
          onChange={(strokeWidth) => update({ strokeWidth }, 'strokeWidth')}
          onCommit={end}
        />
        {e.shape === 'rect' ? (
          <NumberField
            label={t('radius')}
            value={e.radius}
            min={0}
            max={200}
            onChange={(radius) => update({ radius }, 'radius')}
            onCommit={end}
          />
        ) : null}
      </div>
      {e.shape !== 'line' ? (
        <SliderField
          label={t('glass')}
          value={e.glass}
          min={0}
          max={40}
          onChange={(glass) => update({ glass }, 'glass')}
          onCommit={end}
        />
      ) : null}
    </Section>
  );
}

function ImageProperties({ e, update, end }: TypeProps<'image'>) {
  const t = useTranslations('designs.editor.props');
  return (
    <Section>
      <SelectField
        label={t('fit')}
        value={e.fit}
        options={[
          { value: 'contain', label: t('fitContain') },
          { value: 'cover', label: t('fitCover') },
        ]}
        onChange={(fit) => {
          update({ fit }, 'fit');
          end();
        }}
      />
      <div className="flex items-end gap-2">
        <NumberField
          className="flex-1"
          label={t('radius')}
          value={e.radius}
          min={0}
          max={200}
          onChange={(radius) => update({ radius }, 'radius')}
          onCommit={end}
        />
        <ToggleButton
          pressed={e.flipX}
          label={t('flipX')}
          onClick={() => {
            update({ flipX: !e.flipX }, 'flipX');
            end();
          }}
        >
          <FlipHorizontalIcon className="size-4" aria-hidden />
        </ToggleButton>
      </div>
    </Section>
  );
}

function FaceIconProperties({ e, update, end }: TypeProps<'faceIcon'>) {
  const t = useTranslations('designs.editor.props');
  const swatches = useSwatches();
  return (
    <Section>
      <ColorField
        label={t('color')}
        value={e.color}
        swatches={swatches}
        onChange={(color) => update({ color }, 'color')}
        onCommit={end}
      />
      <SliderField
        label={t('strokeWidth')}
        value={e.strokeWidth}
        min={1}
        max={12}
        step={0.5}
        onChange={(strokeWidth) => update({ strokeWidth }, 'strokeWidth')}
        onCommit={end}
      />
    </Section>
  );
}

function ScanButtonsProperties({ e, update, end }: TypeProps<'scanButtons'>) {
  const t = useTranslations('designs.editor.props');
  const swatches = useSwatches();
  return (
    <Section>
      <SelectField
        label={t('layout')}
        value={e.layout}
        options={[
          { value: 'column', label: t('column') },
          { value: 'row', label: t('row') },
        ]}
        onChange={(layout) => {
          update({ layout }, 'layout');
          end();
        }}
      />
      <div className="grid grid-cols-3 gap-2">
        <NumberField
          label={t('buttonHeight')}
          value={e.height}
          min={36}
          max={80}
          onChange={(height) => update({ height }, 'height')}
          onCommit={end}
        />
        <NumberField
          label={t('gap')}
          value={e.gap}
          min={0}
          max={40}
          onChange={(gap) => update({ gap }, 'gap')}
          onCommit={end}
        />
        <NumberField
          label={t('radius')}
          value={e.radius}
          min={0}
          max={40}
          onChange={(radius) => update({ radius }, 'radius')}
          onCommit={end}
        />
      </div>
      <h4 className="text-xs font-semibold">{t('primary')}</h4>
      <div className="grid grid-cols-2 gap-2">
        <ColorField
          label={t('bg')}
          value={e.primary.bg}
          swatches={swatches}
          onChange={(bg) => update({ primary: { ...e.primary, bg } }, 'primaryBg')}
          onCommit={end}
        />
        <ColorField
          label={t('fg')}
          value={e.primary.fg}
          swatches={swatches}
          onChange={(fg) => update({ primary: { ...e.primary, fg } }, 'primaryFg')}
          onCommit={end}
        />
      </div>
      <h4 className="text-xs font-semibold">{t('secondary')}</h4>
      <div className="grid grid-cols-2 gap-2">
        <ColorField
          label={t('bg')}
          value={e.secondary.bg}
          swatches={swatches}
          onChange={(bg) => update({ secondary: { ...e.secondary, bg } }, 'secondaryBg')}
          onCommit={end}
        />
        <ColorField
          label={t('fg')}
          value={e.secondary.fg}
          swatches={swatches}
          onChange={(fg) => update({ secondary: { ...e.secondary, fg } }, 'secondaryFg')}
          onCommit={end}
        />
        <ColorField<true>
          label={t('border')}
          value={e.secondary.border}
          nullable
          swatches={swatches}
          onChange={(border) =>
            update({ secondary: { ...e.secondary, border } }, 'secondaryBorder')
          }
          onCommit={end}
        />
      </div>
    </Section>
  );
}

function HelpButtonProperties({ e, update, end }: TypeProps<'helpButton'>) {
  const t = useTranslations('designs.editor.props');
  const swatches = useSwatches();
  return (
    <Section>
      <div className="grid grid-cols-2 gap-2">
        <ColorField
          label={t('bg')}
          value={e.bg}
          swatches={swatches}
          onChange={(bg) => update({ bg }, 'bg')}
          onCommit={end}
        />
        <ColorField
          label={t('fg')}
          value={e.fg}
          swatches={swatches}
          onChange={(fg) => update({ fg }, 'fg')}
          onCommit={end}
        />
      </div>
      <NumberField
        label={t('radius')}
        value={e.radius}
        min={0}
        max={40}
        onChange={(radius) => update({ radius }, 'radius')}
        onCommit={end}
      />
    </Section>
  );
}
