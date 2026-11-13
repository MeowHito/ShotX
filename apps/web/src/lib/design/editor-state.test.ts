import {
  blankDesignDoc,
  type DesignDoc,
  type DesignElement,
  designDocSchema,
  designShowsPhotos,
  designTemplateDoc,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_OFFSET,
  type EditorAction,
  editorReducer,
  type EditorState,
  HISTORY_LIMIT,
  initialEditorState,
} from './editor-state';
import { makeShape, makeText, normalizeElement, scanButtonsBoxHeight } from './elements';
import { resizeBox, rotationTo, snapMove } from './geometry';

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function start(doc: DesignDoc = blankDesignDoc(), maxElements = 60) {
  return initialEditorState(doc, 'Event', maxElements);
}

const byId = (s: EditorState, id: string) =>
  s.doc.elements.find((e) => e.id === id) as DesignElement;
const ids = (s: EditorState) => s.doc.elements.map((e) => e.id);
const valid = (s: EditorState) => expect(designDocSchema.safeParse(s.doc).success).toBe(true);

describe('editor reducer (ADR 0013)', () => {
  it('ADR 0019: "show all photos" is one undo step, valid, and a no-op when unchanged', () => {
    const s0 = start();
    expect(designShowsPhotos(s0.doc)).toBe(true);
    const off = run(s0, { type: 'showPhotos', value: false });
    expect(off.doc.showPhotos).toBe(false);
    expect(designShowsPhotos(off.doc)).toBe(false);
    expect(off.version).toBe(s0.version + 1);
    valid(off);
    expect(run(off, { type: 'showPhotos', value: false })).toBe(off);
    const undone = run(off, { type: 'undo' });
    expect(designShowsPhotos(undone.doc)).toBe(true);
    expect(designDocSchema.safeParse({ ...s0.doc, showPhotos: 'no' }).success).toBe(false);
  });

  it('adds an element on top, selects it, and keeps the document valid', () => {
    const rect = makeShape('rect');
    const s = run(start(), { type: 'add', element: rect });
    expect(ids(s).at(-1)).toBe(rect.id);
    expect(s.selection).toEqual([rect.id]);
    expect(s.past).toHaveLength(1);
    expect(s.version).toBe(1);
    valid(s);
  });

  it('a drag (same coalesce key) is one undo step; the next gesture is another', () => {
    const rect = makeShape('rect');
    let s = run(start(), { type: 'add', element: rect });
    for (let i = 1; i <= 5; i++) {
      s = run(s, {
        type: 'update',
        changes: { [rect.id]: { x: rect.x + i * 10, y: rect.y + i } },
        coalesce: 'move-1',
      });
    }
    expect(byId(s, rect.id)).toMatchObject({ x: rect.x + 50, y: rect.y + 5 });
    expect(s.past).toHaveLength(2);
    s = run(
      s,
      { type: 'endGesture' },
      { type: 'update', changes: { [rect.id]: { x: 0 } }, coalesce: 'move-1' },
    );
    expect(s.past).toHaveLength(3);
    s = run(s, { type: 'undo' });
    expect(byId(s, rect.id).x).toBe(rect.x + 50);
    s = run(s, { type: 'undo' });
    expect(byId(s, rect.id).x).toBe(rect.x);
    s = run(s, { type: 'redo' }, { type: 'redo' });
    expect(byId(s, rect.id).x).toBe(0);
    expect(s.future).toHaveLength(0);
  });

  it('resizes with the geometry helper and clamps to the schema ranges', () => {
    const rect = makeShape('rect');
    let s = run(start(), { type: 'add', element: rect });
    const box = resizeBox(rect, 'se', 40, 20, false);
    s = run(s, { type: 'update', changes: { [rect.id]: box }, coalesce: 'resize-1' });
    expect(byId(s, rect.id)).toMatchObject({
      x: rect.x,
      y: rect.y,
      w: rect.w + 40,
      h: rect.h + 20,
    });
    s = run(s, {
      type: 'update',
      changes: { [rect.id]: { w: 99999, h: -5, rotation: 270, opacity: 3 } },
    });
    expect(byId(s, rect.id)).toMatchObject({ w: 1688, h: 1, rotation: -90, opacity: 1 });
    valid(s);
  });

  it('the scan buttons keep their box height to the layout (contract box rule)', () => {
    const doc = blankDesignDoc();
    const buttons = doc.elements.find((e) => e.type === 'scanButtons') as Extract<
      DesignElement,
      { type: 'scanButtons' }
    >;
    let s = run(start(doc), { type: 'update', changes: { [buttons.id]: { h: 300 } } });
    expect(byId(s, buttons.id).h).toBe(scanButtonsBoxHeight(buttons));
    s = run(s, {
      type: 'update',
      changes: { [buttons.id]: { layout: 'row', height: 60 } },
    });
    expect(byId(s, buttons.id).h).toBe(60);
  });

  it('never deletes the face icon or the scan buttons; deletes the rest of the selection', () => {
    const doc = blankDesignDoc();
    const face = doc.elements.find((e) => e.type === 'faceIcon') as DesignElement;
    const buttons = doc.elements.find((e) => e.type === 'scanButtons') as DesignElement;
    const help = doc.elements.find((e) => e.type === 'helpButton') as DesignElement;
    let s = run(start(doc), { type: 'select', ids: [face.id] }, { type: 'delete' });
    expect(ids(s)).toContain(face.id);
    expect(s.blocked).toBe('undeletable');
    expect(s.past).toHaveLength(0);
    s = run(s, { type: 'selectAll' }, { type: 'delete' });
    expect(ids(s)).toEqual([face.id, buttons.id]);
    expect(ids(s)).not.toContain(help.id);
    expect(s.blocked).toBe('undeletable');
    valid(s);
    // Nor hidden: that would take them off the share page.
    s = run(s, { type: 'toggleHidden', id: buttons.id });
    expect(byId(s, buttons.id).hidden).toBe(false);
    expect(s.blocked).toBe('undeletable');
    // The help button is optional: deleted, then undo brings it back.
    s = run(s, { type: 'undo' });
    expect(ids(s)).toContain(help.id);
  });

  it('locked elements are not moved, nudged or deleted; L toggles the lock', () => {
    const rect = makeShape('rect');
    let s = run(start(), { type: 'add', element: rect }, { type: 'toggleLock' });
    expect(byId(s, rect.id).locked).toBe(true);
    s = run(s, { type: 'nudge', dx: 10, dy: 0 }, { type: 'delete' });
    expect(byId(s, rect.id).x).toBe(rect.x);
    s = run(s, { type: 'toggleLock' });
    expect(byId(s, rect.id).locked).toBe(false);
    // Select all skips locked and hidden elements.
    s = run(s, { type: 'toggleLock' }, { type: 'selectAll' });
    expect(s.selection).not.toContain(rect.id);
  });

  it('nudges by 1 or 10; a run of nudges is one undo step', () => {
    const rect = makeShape('rect');
    let s = run(start(), { type: 'add', element: rect });
    s = run(
      s,
      { type: 'nudge', dx: 1, dy: 0 },
      { type: 'nudge', dx: 1, dy: 0 },
      { type: 'nudge', dx: 0, dy: 10 },
    );
    expect(byId(s, rect.id)).toMatchObject({ x: rect.x + 2, y: rect.y + 10 });
    expect(s.past).toHaveLength(2);
    s = run(s, { type: 'undo' });
    expect(byId(s, rect.id)).toMatchObject({ x: rect.x, y: rect.y });
  });

  it('duplicates the selection with new ids, offset, above the original; respects cardinality', () => {
    const doc = blankDesignDoc();
    const face = doc.elements.find((e) => e.type === 'faceIcon') as DesignElement;
    const text = makeText('heading', 'Hello');
    let s = run(
      start(doc),
      { type: 'add', element: text },
      { type: 'select', ids: [text.id, face.id] },
      { type: 'duplicate' },
    );
    expect(s.doc.elements).toHaveLength(doc.elements.length + 2);
    const copy = s.doc.elements.at(-1) as DesignElement;
    expect(copy.id).not.toBe(text.id);
    expect(copy).toMatchObject({
      type: 'text',
      text: 'Hello',
      x: text.x + DUPLICATE_OFFSET,
      y: text.y + DUPLICATE_OFFSET,
    });
    // The face icon is "exactly one": not duplicated.
    expect(s.doc.elements.filter((e) => e.type === 'faceIcon')).toHaveLength(1);
    expect(s.selection).toEqual([copy.id]);
    valid(s);
    // Copy and paste do the same through the clipboard.
    s = run(s, { type: 'copy' }, { type: 'paste' }, { type: 'paste' });
    expect(s.doc.elements.filter((e) => e.type === 'text')).toHaveLength(4);
    expect(new Set(ids(s)).size).toBe(s.doc.elements.length);
    valid(s);
  });

  it('refuses to add past DESIGN_MAX_ELEMENTS', () => {
    const doc = blankDesignDoc();
    let s = start(doc, doc.elements.length + 1);
    s = run(s, { type: 'add', element: makeShape('rect') });
    expect(s.blocked).toBeNull();
    s = run(s, { type: 'add', element: makeShape('ellipse') });
    expect(s.blocked).toBe('limit');
    expect(s.doc.elements).toHaveLength(doc.elements.length + 1);
    s = run(s, { type: 'duplicate' });
    expect(s.blocked).toBe('limit');
  });

  it('changes the layer order: forward, backward, front, back, and drag in Layers', () => {
    const a = makeShape('rect');
    const b = makeShape('ellipse');
    const c = makeShape('line');
    let s = run(
      start({ ...blankDesignDoc(), elements: [] }),
      { type: 'add', element: a },
      { type: 'add', element: b },
      { type: 'add', element: c },
    );
    s = run(s, { type: 'select', ids: [a.id] }, { type: 'order', move: 'forward' });
    expect(ids(s)).toEqual([b.id, a.id, c.id]);
    s = run(s, { type: 'order', move: 'front' });
    expect(ids(s)).toEqual([b.id, c.id, a.id]);
    s = run(s, { type: 'order', move: 'back' });
    expect(ids(s)).toEqual([a.id, b.id, c.id]);
    s = run(s, { type: 'select', ids: [c.id] }, { type: 'order', move: 'backward' });
    expect(ids(s)).toEqual([a.id, c.id, b.id]);
    s = run(s, { type: 'moveLayer', id: b.id, toIndex: 0 });
    expect(ids(s)).toEqual([b.id, a.id, c.id]);
    s = run(s, { type: 'undo' });
    expect(ids(s)).toEqual([a.id, c.id, b.id]);
  });

  it('Shift-click toggles in and out of the selection; hiding deselects', () => {
    const a = makeShape('rect');
    const b = makeShape('ellipse');
    let s = run(start(), { type: 'add', element: a }, { type: 'add', element: b });
    s = run(s, { type: 'select', ids: [a.id] }, { type: 'select', ids: [b.id], additive: true });
    expect(s.selection).toEqual([a.id, b.id]);
    s = run(s, { type: 'select', ids: [a.id], additive: true });
    expect(s.selection).toEqual([b.id]);
    s = run(s, { type: 'toggleHidden', id: b.id });
    expect(byId(s, b.id).hidden).toBe(true);
    expect(s.selection).toEqual([]);
  });

  it('templates replace the document (undoable); rename bumps the version, not the history', () => {
    let s = run(start(), { type: 'replaceDoc', doc: designTemplateDoc('bold-poster') });
    expect(s.doc.background).toEqual({ type: 'color', color: '#0a0a0a' });
    s = run(s, { type: 'rename', name: 'New name' });
    expect(s.name).toBe('New name');
    expect(s.past).toHaveLength(1);
    s = run(s, { type: 'undo' });
    expect(s.doc).toEqual(blankDesignDoc());
    expect(s.name).toBe('New name');
  });

  it('keeps at most HISTORY_LIMIT undo steps', () => {
    const rect = makeShape('rect');
    let s = run(start(), { type: 'add', element: rect });
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      s = run(s, { type: 'update', changes: { [rect.id]: { x: i } } });
    }
    expect(s.past).toHaveLength(HISTORY_LIMIT);
  });

  it('normalizes text weights to the schema (multiples of 100, 300..900)', () => {
    const text = normalizeElement({ ...makeText('body', 'x'), weight: 250, size: 500 });
    expect(text).toMatchObject({ weight: 300, size: 200 });
  });
});

describe('designer geometry', () => {
  it('resizing keeps the opposite side fixed, Shift keeps the ratio', () => {
    const box = { x: 100, y: 100, w: 200, h: 100, rotation: 0 };
    expect(resizeBox(box, 'w', -50, 0, false)).toEqual({ x: 50, y: 100, w: 250, h: 100 });
    expect(resizeBox(box, 'n', 0, 30, false)).toEqual({ x: 100, y: 130, w: 200, h: 70 });
    const ratio = resizeBox(box, 'se', 100, 0, true);
    expect(ratio.w / ratio.h).toBeCloseTo(2);
    expect(ratio).toMatchObject({ x: 100, y: 100, w: 300 });
    expect(resizeBox(box, 'e', -500, 0, false).w).toBe(1);
  });

  it('resizes a rotated box in its own frame', () => {
    const box = { x: 0, y: 0, w: 100, h: 50, rotation: 90 };
    // Rotated 90°: dragging the east handle down grows the width.
    const next = resizeBox(box, 'e', 0, 40, false);
    expect(next.w).toBeCloseTo(140);
    expect(next.h).toBeCloseTo(50);
  });

  it('smart guides snap to the artboard centre and to other elements', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    // Centre of the artboard is x = 195: a box at 143 has its centre at 193.
    const snapped = snapMove(box, 143, 400, [], 6);
    expect(snapped.dx).toBe(145);
    expect(snapped.guides).toContainEqual({ axis: 'x', at: 195 });
    const toOther = snapMove(box, 0, 297, [{ x: 300, y: 350, w: 50, h: 50 }], 6);
    expect(toOther.dy).toBe(300);
    expect(snapMove(box, 60, 400, [], 6).guides.filter((g) => g.axis === 'x')).toEqual([]);
  });

  it('rotates towards the pointer, Shift snaps to 15°', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(rotationTo(box, 50, -100, false)).toBe(0);
    expect(rotationTo(box, 200, 50, false)).toBe(90);
    expect(rotationTo(box, 200, 60, true)).toBe(90);
  });
});
