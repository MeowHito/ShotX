import type { DesignBackground, DesignDoc, DesignElement } from '@shotx/shared';
import { canAddType, isDeletable, newElementId, normalizeElement, round } from './elements';

/**
 * The designer's state (ADR 0013): the document, the name, the selection and an undo history.
 * One small reducer; every change to the document is one undo step, except changes that carry
 * the same `coalesce` key as the step before (a drag, a slider, a stream of nudges), which merge
 * into that step. Selection and the clipboard are not part of the history.
 */

/** What an undo step restores. */
interface Snapshot {
  doc: DesignDoc;
  selection: readonly string[];
}

export interface EditorState {
  doc: DesignDoc;
  name: string;
  selection: readonly string[];
  past: readonly Snapshot[];
  future: readonly Snapshot[];
  /** The coalesce key of the last document change (null: the next change is a new step). */
  coalesceKey: string | null;
  /** Copied elements (⌘C), pasted with new ids (⌘V). */
  clipboard: readonly DesignElement[];
  /** Bumped on every document or name change: autosave watches it. */
  version: number;
  /** DESIGN_MAX_ELEMENTS: adding past it is refused (`blocked`). */
  maxElements: number;
  /** Why the last action did nothing, for a short notice; cleared by the next action. */
  blocked: 'limit' | 'undeletable' | null;
}

/** Undo steps kept. */
export const HISTORY_LIMIT = 100;

/** How far a duplicate or a paste is offset from its original, design units. */
export const DUPLICATE_OFFSET = 16;

export type LayerMove = 'forward' | 'backward' | 'front' | 'back';

export type EditorAction =
  | { type: 'load'; doc: DesignDoc; name: string }
  | { type: 'select'; ids: readonly string[]; additive?: boolean }
  | { type: 'selectAll' }
  | { type: 'deselect' }
  | { type: 'add'; element: DesignElement }
  | {
      type: 'update';
      /** Partial changes per element id (its `type` can't change). */
      changes: Readonly<Record<string, Partial<DesignElement>>>;
      coalesce?: string;
    }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'delete' }
  | { type: 'duplicate' }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'order'; move: LayerMove }
  | { type: 'moveLayer'; id: string; toIndex: number }
  | { type: 'toggleLock'; ids?: readonly string[] }
  | { type: 'toggleHidden'; id: string }
  | { type: 'background'; background: DesignBackground; coalesce?: string }
  | { type: 'replaceDoc'; doc: DesignDoc }
  | { type: 'rename'; name: string }
  | { type: 'endGesture' }
  | { type: 'undo' }
  | { type: 'redo' };

export function initialEditorState(doc: DesignDoc, name: string, maxElements: number): EditorState {
  return {
    doc,
    name,
    selection: [],
    past: [],
    future: [],
    coalesceKey: null,
    clipboard: [],
    version: 0,
    maxElements,
    blocked: null,
  };
}

/** A new document state as one undo step (or merged into the last one with the same key). */
function commit(
  state: EditorState,
  doc: DesignDoc,
  selection: readonly string[] = state.selection,
  coalesce: string | null = null,
): EditorState {
  const merge = coalesce !== null && coalesce === state.coalesceKey;
  const past = merge
    ? state.past
    : [...state.past, { doc: state.doc, selection: state.selection }].slice(-HISTORY_LIMIT);
  return {
    ...state,
    doc,
    selection,
    past,
    future: [],
    coalesceKey: coalesce,
    version: state.version + 1,
    blocked: null,
  };
}

const withElements = (doc: DesignDoc, elements: DesignElement[]): DesignDoc => ({
  ...doc,
  elements,
});

/** Selected elements that exist, in document order. */
export function selectedElements(state: Pick<EditorState, 'doc' | 'selection'>): DesignElement[] {
  const ids = new Set(state.selection);
  return state.doc.elements.filter((e) => ids.has(e.id));
}

/** Copies of `elements` with new ids, offset, that fit the cardinality and element limits. */
function copiesOf(state: EditorState, elements: readonly DesignElement[]): DesignElement[] | null {
  const copies: DesignElement[] = [];
  let doc = state.doc;
  for (const e of elements) {
    if (!canAddType(doc, e.type)) continue;
    const copy = normalizeElement({
      ...e,
      id: newElementId(e.type),
      x: e.x + DUPLICATE_OFFSET,
      y: e.y + DUPLICATE_OFFSET,
      locked: false,
    });
    copies.push(copy);
    doc = withElements(doc, [...doc.elements, copy]);
  }
  if (state.doc.elements.length + copies.length > state.maxElements) return null;
  return copies;
}

function reorder(elements: readonly DesignElement[], ids: ReadonlySet<string>, move: LayerMove) {
  const list = [...elements];
  if (move === 'front' || move === 'back') {
    const picked = list.filter((e) => ids.has(e.id));
    const rest = list.filter((e) => !ids.has(e.id));
    return move === 'front' ? [...rest, ...picked] : [...picked, ...rest];
  }
  if (move === 'forward') {
    for (let i = list.length - 2; i >= 0; i--) {
      const a = list[i] as DesignElement;
      const b = list[i + 1] as DesignElement;
      if (ids.has(a.id) && !ids.has(b.id)) {
        list[i] = b;
        list[i + 1] = a;
      }
    }
  } else {
    for (let i = 1; i < list.length; i++) {
      const a = list[i] as DesignElement;
      const b = list[i - 1] as DesignElement;
      if (ids.has(a.id) && !ids.has(b.id)) {
        list[i] = b;
        list[i - 1] = a;
      }
    }
  }
  return list;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const cleared = state.blocked === null ? state : { ...state, blocked: null };
  switch (action.type) {
    case 'load':
      return {
        ...initialEditorState(action.doc, action.name, state.maxElements),
        clipboard: state.clipboard,
      };

    case 'select': {
      const existing = new Set(state.doc.elements.map((e) => e.id));
      const ids = action.ids.filter((id) => existing.has(id));
      if (!action.additive) return { ...cleared, selection: ids, coalesceKey: null };
      const next = new Set(state.selection);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return { ...cleared, selection: [...next], coalesceKey: null };
    }
    case 'selectAll':
      return {
        ...cleared,
        selection: state.doc.elements.filter((e) => !e.locked && !e.hidden).map((e) => e.id),
        coalesceKey: null,
      };
    case 'deselect':
      return { ...cleared, selection: [], coalesceKey: null };

    case 'add': {
      if (state.doc.elements.length >= state.maxElements) return { ...state, blocked: 'limit' };
      if (!canAddType(state.doc, action.element.type)) return cleared;
      const element = normalizeElement(action.element);
      return commit(state, withElements(state.doc, [...state.doc.elements, element]), [element.id]);
    }

    case 'update': {
      let changed = false;
      const elements = state.doc.elements.map((e) => {
        const patch = action.changes[e.id];
        if (patch === undefined) return e;
        changed = true;
        return normalizeElement({ ...e, ...patch, id: e.id, type: e.type } as DesignElement);
      });
      if (!changed) return cleared;
      return commit(
        state,
        withElements(state.doc, elements),
        state.selection,
        action.coalesce ?? null,
      );
    }

    case 'nudge': {
      const ids = new Set(state.selection);
      const movable = state.doc.elements.filter((e) => ids.has(e.id) && !e.locked);
      if (movable.length === 0) return cleared;
      const move = new Set(movable.map((e) => e.id));
      const elements = state.doc.elements.map((e) =>
        move.has(e.id)
          ? normalizeElement({ ...e, x: round(e.x + action.dx), y: round(e.y + action.dy) })
          : e,
      );
      // A run of nudges on the same selection is one undo step.
      return commit(
        state,
        withElements(state.doc, elements),
        state.selection,
        `nudge:${[...move].join(',')}`,
      );
    }

    case 'delete': {
      const ids = new Set(state.selection);
      const selected = state.doc.elements.filter((e) => ids.has(e.id));
      if (selected.length === 0) return cleared;
      const removable = new Set(
        selected.filter((e) => isDeletable(e) && !e.locked).map((e) => e.id),
      );
      if (removable.size === 0) {
        return selected.some((e) => !isDeletable(e))
          ? { ...state, blocked: 'undeletable' }
          : cleared;
      }
      const next = commit(
        state,
        withElements(
          state.doc,
          state.doc.elements.filter((e) => !removable.has(e.id)),
        ),
        state.selection.filter((id) => !removable.has(id)),
      );
      return selected.some((e) => !isDeletable(e)) ? { ...next, blocked: 'undeletable' } : next;
    }

    case 'duplicate': {
      const selected = selectedElements(state);
      if (selected.length === 0) return cleared;
      const copies = copiesOf(state, selected);
      if (copies === null) return { ...state, blocked: 'limit' };
      if (copies.length === 0) return cleared;
      // Each copy goes right above the topmost selected element.
      const lastIndex = Math.max(...selected.map((e) => state.doc.elements.indexOf(e)));
      const elements = [...state.doc.elements];
      elements.splice(lastIndex + 1, 0, ...copies);
      return commit(
        state,
        withElements(state.doc, elements),
        copies.map((c) => c.id),
      );
    }

    case 'copy': {
      const selected = selectedElements(state);
      return selected.length === 0 ? cleared : { ...cleared, clipboard: selected };
    }
    case 'paste': {
      if (state.clipboard.length === 0) return cleared;
      const copies = copiesOf(state, state.clipboard);
      if (copies === null) return { ...state, blocked: 'limit' };
      if (copies.length === 0) return cleared;
      return commit(
        { ...state, clipboard: copies },
        withElements(state.doc, [...state.doc.elements, ...copies]),
        copies.map((c) => c.id),
      );
    }

    case 'order': {
      const ids = new Set(state.selection);
      if (ids.size === 0) return cleared;
      const elements = reorder(state.doc.elements, ids, action.move);
      if (elements.every((e, i) => e === state.doc.elements[i])) return cleared;
      return commit(state, withElements(state.doc, elements));
    }

    case 'moveLayer': {
      const from = state.doc.elements.findIndex((e) => e.id === action.id);
      if (from < 0) return cleared;
      const to = Math.max(0, Math.min(state.doc.elements.length - 1, action.toIndex));
      if (from === to) return cleared;
      const elements = [...state.doc.elements];
      const [moved] = elements.splice(from, 1);
      elements.splice(to, 0, moved as DesignElement);
      return commit(state, withElements(state.doc, elements));
    }

    case 'toggleLock': {
      const ids = new Set(action.ids ?? state.selection);
      const targets = state.doc.elements.filter((e) => ids.has(e.id));
      if (targets.length === 0) return cleared;
      // Lock all unless all are locked already.
      const lock = !targets.every((e) => e.locked);
      return commit(
        state,
        withElements(
          state.doc,
          state.doc.elements.map((e) => (ids.has(e.id) ? { ...e, locked: lock } : e)),
        ),
      );
    }

    case 'toggleHidden': {
      const target = state.doc.elements.find((e) => e.id === action.id);
      if (target === undefined) return cleared;
      // Hiding the face icon or the scan buttons would remove them from the share page; only
      // showing them again is allowed (a document from elsewhere may have them hidden).
      if (!isDeletable(target) && !target.hidden) return { ...state, blocked: 'undeletable' };
      const elements = state.doc.elements.map((e) =>
        e.id === action.id ? { ...e, hidden: !e.hidden } : e,
      );
      const hidden = elements.find((e) => e.id === action.id)?.hidden === true;
      return commit(
        state,
        withElements(state.doc, elements),
        hidden ? state.selection.filter((id) => id !== action.id) : state.selection,
      );
    }

    case 'background':
      return commit(
        state,
        { ...state.doc, background: action.background },
        state.selection,
        action.coalesce ?? null,
      );

    case 'replaceDoc':
      return commit(state, action.doc, []);

    case 'rename':
      return action.name === state.name
        ? cleared
        : { ...cleared, name: action.name, version: state.version + 1 };

    case 'endGesture':
      return state.coalesceKey === null ? state : { ...state, coalesceKey: null };

    case 'undo': {
      const previous = state.past.at(-1);
      if (previous === undefined) return cleared;
      return {
        ...cleared,
        doc: previous.doc,
        selection: previous.selection,
        past: state.past.slice(0, -1),
        future: [{ doc: state.doc, selection: state.selection }, ...state.future],
        coalesceKey: null,
        version: state.version + 1,
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (next === undefined) return cleared;
      return {
        ...cleared,
        doc: next.doc,
        selection: next.selection,
        past: [...state.past, { doc: state.doc, selection: state.selection }],
        future: state.future.slice(1),
        coalesceKey: null,
        version: state.version + 1,
      };
    }
  }
}
