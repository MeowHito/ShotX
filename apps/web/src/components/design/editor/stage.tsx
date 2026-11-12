'use client';

import { DESIGN_ARTBOARD, DESIGN_TEXT_MAX_LENGTH, type DesignElement } from '@shotx/shared';
import { useTranslations } from 'next-intl';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { selectedElements } from '@/lib/design/editor-state';
import { scanButtonsBoxHeight } from '@/lib/design/elements';
import {
  type Box,
  type Guide,
  HANDLES,
  type Handle,
  intersects,
  resizeBox,
  rotatedBounds,
  rotationTo,
  snapMove,
  unionBounds,
} from '@/lib/design/geometry';
import { DesignCanvas, du, textStyle } from '../design-canvas';
import { useEditor } from './editor-context';

/** Space around the artboard in the stage, CSS px. */
export const STAGE_PADDING = 48;
/** Snap distance of the smart guides, CSS px (turned into design units by the zoom). */
const SNAP_PX = 6;

type Drag =
  | {
      kind: 'move';
      startX: number;
      startY: number;
      start: Map<string, DesignElement>;
      key: string;
      moved: boolean;
    }
  | {
      kind: 'resize';
      handle: Handle;
      startX: number;
      startY: number;
      start: DesignElement;
      key: string;
    }
  | { kind: 'rotate'; start: DesignElement; key: string }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean; base: readonly string[] };

let gestureCounter = 0;
const nextKey = (kind: string) => `${kind}-${++gestureCounter}`;

const HANDLE_CURSOR: Record<Handle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

function handlePosition(h: Handle): CSSProperties {
  const x = h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%';
  const y = h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%';
  return { left: x, top: y };
}

/**
 * The centre of the editor: the artboard drawn by DesignCanvas at `zoom` px per design unit, and
 * over it the editing layer: a hit box per selectable element (click, Shift-click, drag),
 * the selection frame with 8 resize handles (Shift keeps the ratio) and a rotate handle, smart
 * guides while moving, marquee selection on the empty artboard, the in-place text editor
 * (double-click a text), and Space+drag panning.
 */
export function Stage({
  zoom,
  spaceHeld,
  editingId,
  onEditText,
  pendingAssets,
}: {
  zoom: number;
  spaceHeld: boolean;
  editingId: string | null;
  onEditText: (id: string | null) => void;
  pendingAssets: ReadonlySet<string>;
}) {
  const t = useTranslations('designs.editor');
  const { state, dispatch, assets } = useEditor();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const latest = useRef({ state, zoom });
  useEffect(() => {
    latest.current = { state, zoom };
  });

  const urls = useMemo(
    () => Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, a.url])),
    [assets],
  );
  const selected = selectedElements(state);
  const single = selected.length === 1 ? (selected[0] as DesignElement) : null;
  const selectionBounds = unionBounds(selected);

  /** Pointer position in design units. */
  function toDesign(clientX: number, clientY: number) {
    const rect = overlayRef.current?.getBoundingClientRect();
    const z = latest.current.zoom;
    return { x: (clientX - (rect?.left ?? 0)) / z, y: (clientY - (rect?.top ?? 0)) / z };
  }

  // Pointer moves and the release are followed on the window during a gesture.
  useEffect(() => {
    if (drag === null) return;
    function onMove(event: PointerEvent) {
      if (drag === null) return;
      const { state: s, zoom: z } = latest.current;
      switch (drag.kind) {
        case 'move': {
          const dx = (event.clientX - drag.startX) / z;
          const dy = (event.clientY - drag.startY) / z;
          if (!drag.moved && Math.hypot(dx * z, dy * z) < 3) return;
          drag.moved = true;
          const moving = [...drag.start.values()];
          const bounds = unionBounds(moving);
          if (bounds === null) return;
          const others = s.doc.elements
            .filter((e) => !drag.start.has(e.id) && !e.hidden)
            .map(rotatedBounds);
          const snap = event.altKey
            ? { dx, dy, guides: [] }
            : snapMove(bounds, dx, dy, others, SNAP_PX / z);
          setGuides(snap.guides);
          const changes: Record<string, Partial<DesignElement>> = {};
          for (const e of moving) changes[e.id] = { x: e.x + snap.dx, y: e.y + snap.dy };
          dispatch({ type: 'update', changes, coalesce: drag.key });
          return;
        }
        case 'resize': {
          const e = drag.start;
          const box = resizeBox(
            e,
            drag.handle,
            (event.clientX - drag.startX) / z,
            (event.clientY - drag.startY) / z,
            event.shiftKey,
          );
          let patch: Partial<DesignElement> = box;
          if (e.type === 'scanButtons') {
            // The box height follows the buttons (contract box rule): resize the buttons.
            const height = e.layout === 'row' ? box.h : (box.h - e.gap) / 2;
            const h = scanButtonsBoxHeight({ ...e, height: Math.min(80, Math.max(36, height)) });
            patch = {
              x: box.x,
              y: box.y + (box.h - h) / 2,
              w: box.w,
              height,
            };
          }
          dispatch({ type: 'update', changes: { [e.id]: patch }, coalesce: drag.key });
          return;
        }
        case 'rotate': {
          const p = toDesign(event.clientX, event.clientY);
          dispatch({
            type: 'update',
            changes: {
              [drag.start.id]: { rotation: rotationTo(drag.start, p.x, p.y, event.shiftKey) },
            },
            coalesce: drag.key,
          });
          return;
        }
        case 'marquee': {
          const p = toDesign(event.clientX, event.clientY);
          const start = toDesign(drag.startX, drag.startY);
          const box = {
            x: Math.min(p.x, start.x),
            y: Math.min(p.y, start.y),
            w: Math.abs(p.x - start.x),
            h: Math.abs(p.y - start.y),
          };
          setMarquee(box);
          const hits = s.doc.elements
            .filter((e) => !e.locked && !e.hidden && intersects(box, rotatedBounds(e)))
            .map((e) => e.id);
          dispatch({
            type: 'select',
            ids: drag.additive ? [...new Set([...drag.base, ...hits])] : hits,
          });
          return;
        }
      }
    }
    function onUp() {
      setDrag(null);
      setGuides([]);
      setMarquee(null);
      dispatch({ type: 'endGesture' });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, dispatch]);

  function onElementDown(event: ReactPointerEvent, e: DesignElement) {
    // Space+drag pans: the editor's stage handles it.
    if (event.button !== 0 || spaceHeld) return;
    event.stopPropagation();
    if (editingId !== null && editingId !== e.id) onEditText(null);
    const isSelected = state.selection.includes(e.id);
    let ids: readonly string[];
    if (event.shiftKey) {
      dispatch({ type: 'select', ids: [e.id], additive: true });
      ids = isSelected ? state.selection.filter((id) => id !== e.id) : [...state.selection, e.id];
      if (isSelected) return;
    } else if (!isSelected) {
      dispatch({ type: 'select', ids: [e.id] });
      ids = [e.id];
    } else {
      ids = state.selection;
    }
    const start = new Map(
      state.doc.elements.filter((x) => ids.includes(x.id) && !x.locked).map((x) => [x.id, x]),
    );
    if (start.size === 0) return;
    setDrag({
      kind: 'move',
      startX: event.clientX,
      startY: event.clientY,
      start,
      key: nextKey('move'),
      moved: false,
    });
  }

  function onBackgroundDown(event: ReactPointerEvent) {
    if (event.button !== 0 || spaceHeld) return;
    event.stopPropagation();
    if (editingId !== null) onEditText(null);
    if (!event.shiftKey) dispatch({ type: 'deselect' });
    setDrag({
      kind: 'marquee',
      startX: event.clientX,
      startY: event.clientY,
      additive: event.shiftKey,
      base: event.shiftKey ? state.selection : [],
    });
  }

  const editing =
    editingId === null
      ? null
      : (state.doc.elements.find((e) => e.id === editingId && e.type === 'text') ?? null);

  const overlay = (
    <div
      ref={overlayRef}
      className="absolute inset-0"
      style={{ touchAction: 'none', cursor: spaceHeld ? 'grab' : undefined }}
      onPointerDown={onBackgroundDown}
      data-testid="design-overlay"
    >
      {state.doc.elements.map((e) =>
        e.hidden || e.locked ? null : (
          <div
            key={e.id}
            data-hit-id={e.id}
            aria-hidden
            className="absolute"
            style={{
              left: du(e.x),
              top: du(e.y),
              width: du(e.w),
              height: du(e.h),
              transform: e.rotation !== 0 ? `rotate(${e.rotation}deg)` : undefined,
              cursor: spaceHeld ? 'grab' : 'move',
            }}
            onPointerDown={(event) => onElementDown(event, e)}
            onDoubleClick={() => {
              if (e.type === 'text') onEditText(e.id);
            }}
          />
        ),
      )}

      {/* The selection: each selected element's outline, and the handles of a single one. */}
      {selected.map((e) => (
        <div
          key={`sel-${e.id}`}
          className="pointer-events-none absolute outline-2 -outline-offset-1 outline-primary outline-solid"
          style={{
            left: du(e.x),
            top: du(e.y),
            width: du(e.w),
            height: du(e.h),
            transform: e.rotation !== 0 ? `rotate(${e.rotation}deg)` : undefined,
          }}
        />
      ))}
      {selected.length > 1 && selectionBounds !== null ? (
        <div
          className="pointer-events-none absolute outline-1 outline-primary/60 outline-dashed"
          style={{
            left: du(selectionBounds.x),
            top: du(selectionBounds.y),
            width: du(selectionBounds.w),
            height: du(selectionBounds.h),
          }}
        />
      ) : null}
      {single !== null && !single.locked && editingId === null ? (
        <div
          className="pointer-events-none absolute"
          style={{
            left: du(single.x),
            top: du(single.y),
            width: du(single.w),
            height: du(single.h),
            transform: single.rotation !== 0 ? `rotate(${single.rotation}deg)` : undefined,
          }}
        >
          {HANDLES.map((h) => (
            <div
              key={h}
              data-handle={h}
              className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-white shadow"
              style={{ ...handlePosition(h), cursor: HANDLE_CURSOR[h], touchAction: 'none' }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                setDrag({
                  kind: 'resize',
                  handle: h,
                  startX: event.clientX,
                  startY: event.clientY,
                  start: single,
                  key: nextKey('resize'),
                });
              }}
            />
          ))}
          <div
            className="absolute left-1/2 h-6 w-px -translate-x-1/2 bg-primary"
            style={{ top: -24 }}
          />
          <div
            data-handle="rotate"
            className="pointer-events-auto absolute left-1/2 size-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-primary bg-white shadow"
            style={{ top: -32, touchAction: 'none' }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              setDrag({ kind: 'rotate', start: single, key: nextKey('rotate') });
            }}
          />
        </div>
      ) : null}

      {guides.map((g) => (
        <div
          key={`${g.axis}-${g.at}`}
          className="pointer-events-none absolute bg-fuchsia-500"
          style={
            g.axis === 'x'
              ? {
                  left: du(g.at),
                  top: du(-DESIGN_ARTBOARD.height),
                  width: 1,
                  height: du(3 * DESIGN_ARTBOARD.height),
                }
              : {
                  top: du(g.at),
                  left: du(-DESIGN_ARTBOARD.width),
                  height: 1,
                  width: du(3 * DESIGN_ARTBOARD.width),
                }
          }
        />
      ))}
      {marquee !== null ? (
        <div
          className="pointer-events-none absolute border border-primary bg-primary/10"
          style={{
            left: du(marquee.x),
            top: du(marquee.y),
            width: du(marquee.w),
            height: du(marquee.h),
          }}
        />
      ) : null}

      {editing !== null && editing.type === 'text' ? (
        <InlineTextEditor element={editing} onDone={() => onEditText(null)} />
      ) : null}
    </div>
  );

  // The editing layer sits beside the canvas, not inside it: the canvas clips to the artboard,
  // handles and outlines of elements at (or past) its edges must not be clipped.
  return (
    <div
      className="relative mx-auto shadow-float"
      style={
        {
          '--u': `${zoom}px`,
          width: DESIGN_ARTBOARD.width * zoom,
          height: DESIGN_ARTBOARD.height * zoom,
        } as CSSProperties
      }
      role="group"
      aria-label={t('canvasLabel')}
    >
      <DesignCanvas
        doc={state.doc}
        assets={urls}
        mode="gallery"
        layout={{ kind: 'artboard', unit: zoom }}
        editingId={editingId}
        pendingAssets={pendingAssets}
      />
      {overlay}
    </div>
  );
}

/**
 * The text being edited in place: a plain textarea over the element with the same font and size,
 * so typing looks like the result. Its value is plain text (a text node when rendered).
 */
function InlineTextEditor({
  element,
  onDone,
}: {
  element: Extract<DesignElement, { type: 'text' }>;
  onDone: () => void;
}) {
  const t = useTranslations('designs.editor');
  const { dispatch } = useEditor();
  const ref = useRef<HTMLTextAreaElement>(null);
  const key = useMemo(() => nextKey(`text-${element.id}`), [element.id]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.focus();
    el.select();
  }, []);
  return (
    <textarea
      ref={ref}
      aria-label={t('textEditor')}
      value={element.text}
      maxLength={DESIGN_TEXT_MAX_LENGTH}
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) =>
        dispatch({
          type: 'update',
          changes: { [element.id]: { text: e.target.value } },
          coalesce: key,
        })
      }
      onBlur={() => {
        dispatch({ type: 'endGesture' });
        onDone();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="absolute m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-2 outline-primary outline-dashed"
      style={{
        ...textStyle(element),
        left: du(element.x),
        top: du(element.y),
        width: du(element.w),
        height: du(element.h),
        minHeight: du(element.size * element.lineHeight),
        transform: element.rotation !== 0 ? `rotate(${element.rotation}deg)` : undefined,
        opacity: element.opacity,
        fieldSizing: 'content',
      }}
    />
  );
}
