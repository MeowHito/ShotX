import type { KeyLike } from '@/lib/studio/shortcuts';

/**
 * Keyboard shortcuts of the designer, exactly as ADR 0013 lists them, with ⌘ on Apple platforms
 * and Ctrl elsewhere. Letters and brackets match `event.code` so they work with any keyboard
 * layout (Thai Kedmanee types Thai letters on those keys). The editor turns them off while typing
 * in a field or editing a text in place (shouldIgnoreKey), and during IME composition.
 */

export type DesignShortcutId =
  | 'undo'
  | 'redo'
  | 'delete'
  | 'duplicate'
  | 'copy'
  | 'paste'
  | 'nudge'
  | 'nudgeBig'
  | 'forward'
  | 'backward'
  | 'front'
  | 'back'
  | 'selectAll'
  | 'deselect'
  | 'addText'
  | 'addRect'
  | 'addEllipse'
  | 'lock'
  | 'save'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'pan'
  | 'help';

export type DesignCommand =
  | { id: Exclude<DesignShortcutId, 'nudge' | 'nudgeBig' | 'pan'> }
  | { id: 'nudge'; dx: number; dy: number };

/** ⌘ on Apple, Ctrl elsewhere; never both. */
function mod(e: KeyLike, apple: boolean): boolean {
  return apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

const noMods = (e: KeyLike) => !e.altKey && !e.ctrlKey && !e.metaKey;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The designer command of a key press, or null. */
export function designShortcut(e: KeyLike, apple: boolean): DesignCommand | null {
  const m = mod(e, apple);
  const arrow = ARROWS[e.key];
  if (arrow !== undefined && noMods(e)) {
    const step = e.shiftKey ? 10 : 1;
    return { id: 'nudge', dx: arrow[0] * step, dy: arrow[1] * step };
  }
  if (m) {
    switch (e.code) {
      case 'KeyZ':
        if (e.altKey) return null;
        return { id: e.shiftKey ? 'redo' : 'undo' };
      case 'KeyY':
        // Ctrl+Y redoes on Windows and Linux (⌘Y is the history window in Safari).
        return !apple && !e.shiftKey && !e.altKey ? { id: 'redo' } : null;
      case 'KeyD':
        return !e.shiftKey && !e.altKey ? { id: 'duplicate' } : null;
      case 'KeyC':
        return !e.shiftKey && !e.altKey ? { id: 'copy' } : null;
      case 'KeyV':
        return !e.shiftKey && !e.altKey ? { id: 'paste' } : null;
      case 'KeyA':
        return !e.shiftKey && !e.altKey ? { id: 'selectAll' } : null;
      case 'KeyS':
        return !e.shiftKey && !e.altKey ? { id: 'save' } : null;
      case 'BracketRight':
        return e.shiftKey ? null : { id: e.altKey ? 'front' : 'forward' };
      case 'BracketLeft':
        return e.shiftKey ? null : { id: e.altKey ? 'back' : 'backward' };
      case 'Equal':
      case 'NumpadAdd':
        return e.altKey ? null : { id: 'zoomIn' };
      case 'Minus':
      case 'NumpadSubtract':
        return e.altKey || e.shiftKey ? null : { id: 'zoomOut' };
      case 'Digit0':
      case 'Numpad0':
        return e.altKey || e.shiftKey ? null : { id: 'zoomFit' };
      case 'Slash':
        return e.altKey ? null : { id: 'help' };
      default:
        return null;
    }
  }
  if (!noMods(e)) return null;
  if (e.key === 'Delete' || e.key === 'Backspace') return e.shiftKey ? null : { id: 'delete' };
  if (e.key === 'Escape') return { id: 'deselect' };
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) return { id: 'help' };
  if (e.shiftKey) return null;
  switch (e.code) {
    case 'KeyT':
      return { id: 'addText' };
    case 'KeyR':
      return { id: 'addRect' };
    case 'KeyE':
      return { id: 'addEllipse' };
    case 'KeyL':
      return { id: 'lock' };
    default:
      return null;
  }
}

/** The help dialog's rows in order, with each platform's keys. */
export const DESIGN_SHORTCUTS: readonly {
  id: DesignShortcutId;
  apple: readonly string[];
  other: readonly string[];
}[] = [
  { id: 'undo', apple: ['⌘Z'], other: ['Ctrl+Z'] },
  { id: 'redo', apple: ['⇧⌘Z'], other: ['Ctrl+Y', 'Ctrl+Shift+Z'] },
  { id: 'delete', apple: ['Delete', '⌫'], other: ['Delete', 'Backspace'] },
  { id: 'duplicate', apple: ['⌘D'], other: ['Ctrl+D'] },
  { id: 'copy', apple: ['⌘C'], other: ['Ctrl+C'] },
  { id: 'paste', apple: ['⌘V'], other: ['Ctrl+V'] },
  { id: 'nudge', apple: ['←↑→↓'], other: ['←↑→↓'] },
  { id: 'nudgeBig', apple: ['⇧←↑→↓'], other: ['Shift+←↑→↓'] },
  { id: 'forward', apple: ['⌘]'], other: ['Ctrl+]'] },
  { id: 'backward', apple: ['⌘['], other: ['Ctrl+['] },
  { id: 'front', apple: ['⌥⌘]'], other: ['Ctrl+Alt+]'] },
  { id: 'back', apple: ['⌥⌘['], other: ['Ctrl+Alt+['] },
  { id: 'selectAll', apple: ['⌘A'], other: ['Ctrl+A'] },
  { id: 'deselect', apple: ['Esc'], other: ['Esc'] },
  { id: 'addText', apple: ['T'], other: ['T'] },
  { id: 'addRect', apple: ['R'], other: ['R'] },
  { id: 'addEllipse', apple: ['E'], other: ['E'] },
  { id: 'lock', apple: ['L'], other: ['L'] },
  { id: 'save', apple: ['⌘S'], other: ['Ctrl+S'] },
  { id: 'zoomIn', apple: ['⌘='], other: ['Ctrl+='] },
  { id: 'zoomOut', apple: ['⌘-'], other: ['Ctrl+-'] },
  { id: 'zoomFit', apple: ['⌘0'], other: ['Ctrl+0'] },
  { id: 'pan', apple: ['Space'], other: ['Space'] },
  { id: 'help', apple: ['?'], other: ['?'] },
];
