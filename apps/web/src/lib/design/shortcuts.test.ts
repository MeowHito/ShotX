import { describe, expect, it } from 'vitest';
import type { KeyLike } from '@/lib/studio/shortcuts';
import { DESIGN_SHORTCUTS, designShortcut } from './shortcuts';

function key(key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods };
}

describe('designer shortcuts (ADR 0013)', () => {
  const mac = (k: KeyLike) => designShortcut(k, true)?.id ?? null;
  const win = (k: KeyLike) => designShortcut(k, false)?.id ?? null;

  it('undo and redo: ⌘Z / ⇧⌘Z on Mac, Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) elsewhere', () => {
    expect(mac(key('z', 'KeyZ', { metaKey: true }))).toBe('undo');
    expect(mac(key('Z', 'KeyZ', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(mac(key('y', 'KeyY', { metaKey: true }))).toBeNull();
    expect(win(key('z', 'KeyZ', { ctrlKey: true }))).toBe('undo');
    expect(win(key('y', 'KeyY', { ctrlKey: true }))).toBe('redo');
    expect(win(key('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    // Ctrl on a Mac is not the modifier.
    expect(mac(key('z', 'KeyZ', { ctrlKey: true }))).toBeNull();
  });

  it('edit commands with the platform modifier; letters by physical key (Thai layout)', () => {
    expect(mac(key('ก', 'KeyD', { metaKey: true }))).toBe('duplicate');
    expect(mac(key('c', 'KeyC', { metaKey: true }))).toBe('copy');
    expect(mac(key('v', 'KeyV', { metaKey: true }))).toBe('paste');
    expect(mac(key('a', 'KeyA', { metaKey: true }))).toBe('selectAll');
    expect(mac(key('s', 'KeyS', { metaKey: true }))).toBe('save');
    expect(win(key('d', 'KeyD', { ctrlKey: true }))).toBe('duplicate');
    expect(mac(key('Delete', 'Delete'))).toBe('delete');
    expect(mac(key('Backspace', 'Backspace'))).toBe('delete');
    expect(mac(key('Escape', 'Escape'))).toBe('deselect');
  });

  it('layer order: ⌘] / ⌘[ one step, ⌥⌘] / ⌥⌘[ to front / back', () => {
    expect(mac(key(']', 'BracketRight', { metaKey: true }))).toBe('forward');
    expect(mac(key('[', 'BracketLeft', { metaKey: true }))).toBe('backward');
    expect(mac(key('‘', 'BracketRight', { metaKey: true, altKey: true }))).toBe('front');
    expect(mac(key('“', 'BracketLeft', { metaKey: true, altKey: true }))).toBe('back');
    expect(win(key(']', 'BracketRight', { ctrlKey: true, altKey: true }))).toBe('front');
  });

  it('arrows nudge 1, Shift+arrows 10', () => {
    expect(designShortcut(key('ArrowLeft', 'ArrowLeft'), true)).toEqual({
      id: 'nudge',
      dx: -1,
      dy: 0,
    });
    expect(designShortcut(key('ArrowDown', 'ArrowDown', { shiftKey: true }), false)).toEqual({
      id: 'nudge',
      dx: 0,
      dy: 10,
    });
    expect(designShortcut(key('ArrowLeft', 'ArrowLeft', { metaKey: true }), true)).toBeNull();
  });

  it('T, R, E, L add text, rectangle, ellipse and toggle the lock; only without modifiers', () => {
    expect(mac(key('t', 'KeyT'))).toBe('addText');
    expect(mac(key('ะ', 'KeyT'))).toBe('addText');
    expect(mac(key('r', 'KeyR'))).toBe('addRect');
    expect(mac(key('e', 'KeyE'))).toBe('addEllipse');
    expect(mac(key('l', 'KeyL'))).toBe('lock');
    expect(mac(key('r', 'KeyR', { metaKey: true }))).toBeNull();
    expect(mac(key('T', 'KeyT', { shiftKey: true }))).toBeNull();
  });

  it('zoom: ⌘= in, ⌘- out, ⌘0 fit; ? opens the list', () => {
    expect(mac(key('=', 'Equal', { metaKey: true }))).toBe('zoomIn');
    expect(mac(key('-', 'Minus', { metaKey: true }))).toBe('zoomOut');
    expect(mac(key('0', 'Digit0', { metaKey: true }))).toBe('zoomFit');
    expect(win(key('=', 'Equal', { ctrlKey: true }))).toBe('zoomIn');
    expect(mac(key('?', 'Slash', { shiftKey: true }))).toBe('help');
  });

  it('the help dialog lists every shortcut once', () => {
    const listed = DESIGN_SHORTCUTS.map((s) => s.id);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(
      expect.arrayContaining([
        'undo',
        'redo',
        'delete',
        'duplicate',
        'copy',
        'paste',
        'nudge',
        'nudgeBig',
        'forward',
        'backward',
        'front',
        'back',
        'selectAll',
        'deselect',
        'addText',
        'addRect',
        'addEllipse',
        'lock',
        'save',
        'zoomIn',
        'zoomOut',
        'zoomFit',
        'pan',
        'help',
      ]),
    );
  });
});
