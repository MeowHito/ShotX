/**
 * Keyboard shortcuts of the studio, for Mac (and iPadOS with a keyboard) and Windows/Linux. One
 * table drives the handlers, the hints in menus and the help dialog (`?`).
 *
 * Choices: no browser-reserved combos (⌘D/Ctrl+D bookmark, ⌘N, ⌘T, ⌘W, Ctrl+Shift+…); letter
 * shortcuts match `event.code` so they work with any layout, including Thai Kedmanee and macOS
 * Option-dead keys (⌥E types nothing as `key`). Nothing fires while typing in a field, inside a
 * dialog or open menu, or during IME composition (Thai input).
 */

export type ShortcutId =
  | 'open'
  | 'preview'
  | 'rename'
  | 'copy'
  | 'paste'
  | 'download'
  | 'trash'
  | 'selectAll'
  | 'clearSelection'
  | 'newFolder'
  | 'upload'
  | 'search'
  | 'help'
  | 'moveFocus'
  | 'extendSelection'
  | 'multiSelectClick';

export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** True on macOS, iOS and iPadOS (which reports itself as a Mac with touch points). */
export function isApplePlatform(
  nav: Pick<Navigator, 'userAgent' | 'platform'> | undefined,
): boolean {
  if (nav === undefined) return false;
  const platform =
    (nav as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? nav.platform;
  return (
    /mac|iphone|ipad|ipod/i.test(platform) || /iphone|ipad|ipod|macintosh/i.test(nav.userAgent)
  );
}

/** ⌘ on Apple platforms, Ctrl elsewhere (and never both, so Ctrl+C on a Mac stays native). */
function mod(event: KeyLike, apple: boolean): boolean {
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const plain = (e: KeyLike) => !e.altKey && !e.ctrlKey && !e.metaKey;

/** Whether `event` is shortcut `id` (the key-driven ones; arrows and clicks are handled apart). */
export function matches(id: ShortcutId, event: KeyLike, apple: boolean): boolean {
  switch (id) {
    case 'open':
      return event.key === 'Enter' && plain(event) && !event.shiftKey;
    case 'preview':
      return event.key === ' ' && plain(event) && !event.shiftKey;
    case 'rename':
      return event.code === 'KeyE' && event.altKey && mod(event, apple) && !event.shiftKey;
    case 'copy':
      return event.code === 'KeyC' && mod(event, apple) && !event.altKey && !event.shiftKey;
    case 'paste':
      return event.code === 'KeyV' && mod(event, apple) && !event.altKey && !event.shiftKey;
    case 'download':
      return event.code === 'KeyD' && event.shiftKey && plain(event);
    // Apple: ⌘⌫ (Finder's convention; a plain ⌫ is too easy to press). Elsewhere: Delete.
    case 'trash':
      return apple
        ? event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            (event.key === 'Backspace' || event.key === 'Delete')
        : plain(event) && !event.shiftKey && event.key === 'Delete';
    case 'selectAll':
      return event.code === 'KeyA' && mod(event, apple) && !event.altKey && !event.shiftKey;
    case 'clearSelection':
      return event.key === 'Escape';
    case 'newFolder':
      return event.code === 'KeyC' && event.altKey && !event.ctrlKey && !event.metaKey;
    case 'upload':
      return event.code === 'KeyU' && event.shiftKey && plain(event);
    // `/` by character or by the physical key (on the Thai Kedmanee layout that key types a Thai letter).
    case 'search':
      return plain(event) && !event.shiftKey && (event.key === '/' || event.code === 'Slash');
    case 'help':
      return (
        (!event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          (event.key === '?' || (event.code === 'Slash' && event.shiftKey))) ||
        ((event.key === '/' || event.code === 'Slash') && mod(event, apple) && !event.altKey)
      );
    default:
      return false;
  }
}

/** Arrow-key focus movement: -1/+1 across, ±columns down and up; null for other keys. */
export function arrowStep(event: KeyLike, columns: number): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.key) {
    case 'ArrowLeft':
      return -1;
    case 'ArrowRight':
      return 1;
    case 'ArrowUp':
      return -columns;
    case 'ArrowDown':
      return columns;
    default:
      return null;
  }
}

/** Multi-select modifier on a click: ⌘ (Apple) or Ctrl adds one item; Shift adds a range. */
export function clickModifier(
  event: Pick<KeyLike, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  apple: boolean,
): 'toggle' | 'range' | null {
  if (event.shiftKey) return 'range';
  if (apple ? event.metaKey : event.ctrlKey) return 'toggle';
  return null;
}

/**
 * True when a key press must be left alone: the user is typing (input, textarea, select,
 * contenteditable), composing with an IME, or working in a dialog or an open menu.
 */
export function shouldIgnoreKey(event: KeyLike & { target: EventTarget | null }): boolean {
  if (event.isComposing === true || event.keyCode === 229) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    return true;
  }
  return target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

/** Display of each shortcut, per platform (help dialog and menu hints). */
const DISPLAY: Record<ShortcutId, { apple: string[]; other: string[] }> = {
  open: { apple: ['Enter'], other: ['Enter'] },
  preview: { apple: ['Space'], other: ['Space'] },
  rename: { apple: ['⌥⌘E'], other: ['Ctrl+Alt+E'] },
  copy: { apple: ['⌘C'], other: ['Ctrl+C'] },
  paste: { apple: ['⌘V'], other: ['Ctrl+V'] },
  download: { apple: ['⇧D'], other: ['Shift+D'] },
  trash: { apple: ['⌘⌫'], other: ['Delete'] },
  selectAll: { apple: ['⌘A'], other: ['Ctrl+A'] },
  clearSelection: { apple: ['Esc'], other: ['Esc'] },
  newFolder: { apple: ['⌥C'], other: ['Alt+C'] },
  upload: { apple: ['⇧U'], other: ['Shift+U'] },
  search: { apple: ['/'], other: ['/'] },
  help: { apple: ['?', '⌘/'], other: ['?', 'Ctrl+/'] },
  moveFocus: { apple: ['←', '→', '↑', '↓'], other: ['←', '→', '↑', '↓'] },
  extendSelection: { apple: ['⇧←→↑↓'], other: ['Shift+←→↑↓'] },
  // The help text says "click while holding".
  multiSelectClick: { apple: ['⌘', '⇧'], other: ['Ctrl', 'Shift'] },
};

/** The order of the help dialog. */
export const SHORTCUT_IDS: readonly ShortcutId[] = [
  'open',
  'preview',
  'moveFocus',
  'extendSelection',
  'multiSelectClick',
  'selectAll',
  'clearSelection',
  'rename',
  'copy',
  'paste',
  'download',
  'trash',
  'newFolder',
  'upload',
  'search',
  'help',
];

export function shortcutKeys(id: ShortcutId, apple: boolean): string[] {
  return DISPLAY[id][apple ? 'apple' : 'other'];
}

/** The first form of a shortcut, for a menu hint. */
export function shortcutHint(id: ShortcutId, apple: boolean): string {
  return shortcutKeys(id, apple)[0] ?? '';
}
