import { describe, expect, it } from 'vitest';
import {
  arrowStep,
  clickModifier,
  isApplePlatform,
  type KeyLike,
  matches,
  SHORTCUT_IDS,
  shortcutHint,
  shortcutKeys,
  shouldIgnoreKey,
} from './shortcuts';

const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('platform', () => {
  it('detects macOS, iPhone and iPadOS (which says Mac), not Windows, Linux or Android', () => {
    const nav = (platform: string, userAgent = '') => ({ platform, userAgent });
    expect(isApplePlatform(nav('MacIntel'))).toBe(true);
    expect(isApplePlatform(nav('iPhone'))).toBe(true);
    expect(isApplePlatform(nav('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'))).toBe(true);
    expect(isApplePlatform(nav('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBe(false);
    expect(isApplePlatform(nav('Linux x86_64'))).toBe(false);
    expect(isApplePlatform(nav('Linux armv8l', 'Mozilla/5.0 (Linux; Android 14)'))).toBe(false);
    expect(isApplePlatform(undefined)).toBe(false);
  });
});

describe('shortcut matching', () => {
  it('uses ⌘ on Apple and Ctrl elsewhere, never both', () => {
    const rename = key('´', 'KeyE', { altKey: true, metaKey: true });
    expect(matches('rename', rename, true)).toBe(true);
    expect(matches('rename', rename, false)).toBe(false);
    expect(matches('rename', key('e', 'KeyE', { altKey: true, ctrlKey: true }), false)).toBe(true);
    expect(matches('copy', key('c', 'KeyC', { metaKey: true }), true)).toBe(true);
    expect(matches('copy', key('c', 'KeyC', { ctrlKey: true }), true)).toBe(false);
    expect(matches('copy', key('c', 'KeyC', { ctrlKey: true }), false)).toBe(true);
    expect(matches('paste', key('v', 'KeyV', { ctrlKey: true }), false)).toBe(true);
    expect(matches('selectAll', key('a', 'KeyA', { metaKey: true }), true)).toBe(true);
  });

  it('matches letters by physical key, so Thai layouts and Option dead keys work', () => {
    // Thai Kedmanee: the C key types "แ"; macOS Option+C types "ç".
    expect(matches('newFolder', key('แ', 'KeyC', { altKey: true }), false)).toBe(true);
    expect(matches('newFolder', key('ç', 'KeyC', { altKey: true }), true)).toBe(true);
    expect(matches('upload', key('U', 'KeyU', { shiftKey: true }), false)).toBe(true);
    expect(matches('download', key('D', 'KeyD', { shiftKey: true }), true)).toBe(true);
  });

  it('avoids browser-reserved combos: ⌘D / Ctrl+D is not download', () => {
    expect(matches('download', key('d', 'KeyD', { metaKey: true }), true)).toBe(false);
    expect(matches('download', key('d', 'KeyD', { ctrlKey: true }), false)).toBe(false);
  });

  it('trashes with Delete on Windows/Linux and only ⌘⌫ on a Mac (a plain ⌫ is too easy)', () => {
    expect(matches('trash', key('Delete', 'Delete'), false)).toBe(true);
    expect(matches('trash', key('Backspace', 'Backspace'), false)).toBe(false);
    expect(matches('trash', key('Delete', 'Delete', { ctrlKey: true }), false)).toBe(false);
    expect(matches('trash', key('Backspace', 'Backspace', { metaKey: true }), true)).toBe(true);
    // fn+⌫ (forward delete) with ⌘ too.
    expect(matches('trash', key('Delete', 'Delete', { metaKey: true }), true)).toBe(true);
    expect(matches('trash', key('Backspace', 'Backspace'), true)).toBe(false);
    expect(matches('trash', key('Delete', 'Delete'), true)).toBe(false);
    expect(
      matches('trash', key('Backspace', 'Backspace', { metaKey: true, shiftKey: true }), true),
    ).toBe(false);
  });

  it('opens help with ?, ⌘/ or Ctrl+/, and focuses search with /', () => {
    expect(matches('help', key('?', 'Slash', { shiftKey: true }), false)).toBe(true);
    expect(matches('help', key('/', 'Slash', { metaKey: true }), true)).toBe(true);
    expect(matches('help', key('/', 'Slash', { ctrlKey: true }), false)).toBe(true);
    expect(matches('search', key('/', 'Slash'), false)).toBe(true);
    expect(matches('search', key('/', 'Slash', { ctrlKey: true }), false)).toBe(false);
    // Thai Kedmanee: the same physical keys type Thai letters.
    expect(matches('search', key('\u0E1D', 'Slash'), false)).toBe(true);
    expect(matches('help', key('\u0E26', 'Slash', { shiftKey: true }), false)).toBe(true);
  });

  it('moves focus with arrows (rows by the column count) and reads click modifiers', () => {
    expect(arrowStep(key('ArrowRight', 'ArrowRight'), 4)).toBe(1);
    expect(arrowStep(key('ArrowUp', 'ArrowUp'), 4)).toBe(-4);
    expect(arrowStep(key('ArrowDown', 'ArrowDown', { shiftKey: true }), 3)).toBe(3);
    expect(arrowStep(key('ArrowDown', 'ArrowDown', { metaKey: true }), 3)).toBeNull();
    expect(clickModifier({ shiftKey: true, ctrlKey: false, metaKey: false }, false)).toBe('range');
    expect(clickModifier({ shiftKey: false, ctrlKey: false, metaKey: true }, true)).toBe('toggle');
    expect(clickModifier({ shiftKey: false, ctrlKey: true, metaKey: false }, true)).toBeNull();
    expect(clickModifier({ shiftKey: false, ctrlKey: true, metaKey: false }, false)).toBe('toggle');
  });
});

describe('when shortcuts stay quiet', () => {
  const event = (target: Element, extra: Partial<KeyLike> = {}) => ({
    ...key('Delete', 'Delete'),
    target,
    ...extra,
  });

  it('ignores typing in fields, dialogs and open menus, and IME composition (Thai input)', () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><div contenteditable="true" id="c"></div>
      <div role="dialog"><button id="d">x</button></div>
      <div role="menu"><div id="m" role="menuitem">x</div></div>
      <button id="b">item</button>`;
    const el = (id: string) => document.getElementById(id) as Element;
    for (const id of ['i', 't', 'c', 'd', 'm'])
      expect(shouldIgnoreKey(event(el(id))), id).toBe(true);
    expect(shouldIgnoreKey(event(el('b')))).toBe(false);
    expect(shouldIgnoreKey(event(el('b'), { isComposing: true }))).toBe(true);
    expect(shouldIgnoreKey(event(el('b'), { keyCode: 229 }))).toBe(true);
  });
});

describe('the documented list', () => {
  it('has keys for every shortcut on both platforms', () => {
    for (const id of SHORTCUT_IDS) {
      expect(shortcutKeys(id, true).length, id).toBeGreaterThan(0);
      expect(shortcutKeys(id, false).length, id).toBeGreaterThan(0);
    }
    expect(shortcutHint('rename', true)).toBe('⌥⌘E');
    expect(shortcutHint('rename', false)).toBe('Ctrl+Alt+E');
    expect(shortcutKeys('trash', true)).toEqual(['⌘⌫']);
    expect(shortcutKeys('trash', false)).toEqual(['Delete']);
  });
});
