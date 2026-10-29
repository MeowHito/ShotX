import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** WCAG 2.2 contrast of the design tokens, read straight from styles.css (light and dark). */
const css = readFileSync(path.join(import.meta.dirname, 'styles.css'), 'utf8');

function block(start: number): string {
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open, i);
  }
  throw new Error('unbalanced');
}

function tokens(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const light = tokens(block(css.search(/^:root \{/m)));
const dark = tokens(block(css.indexOf(':root', css.indexOf('prefers-color-scheme: dark'))));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** [text, background, minimum]: 4.5 for text, 3 for focus rings and control outlines. */
const PAIRS: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['foreground', 'sidebar', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'sidebar', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['primary', 'background', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['primary-foreground', 'primary-hover', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['destructive', 'background', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['warning-foreground', 'background', 4.5],
  ['popover-foreground', 'popover', 4.5],
  ['ring', 'background', 3],
  ['input', 'background', 3],
  ['band-foreground', 'band', 4.5],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s tokens', (_name, palette) => {
  it.each(PAIRS)('%s on %s meets %s:1', (fg, bg, min) => {
    const a = palette[fg];
    const b = palette[bg];
    expect(a, fg).toBeDefined();
    expect(b, bg).toBeDefined();
    expect(contrast(a as string, b as string)).toBeGreaterThanOrEqual(min);
  });
});

describe('brand', () => {
  it('uses the deep indigo for primary actions and the hairline for borders', () => {
    expect(light.primary).toBe('#0c4369');
    expect(light['primary-hover']).toBe('#0a3858');
    expect(light.foreground).toBe('#111820');
    expect(light.sidebar).toBe('#f4f6f7');
    expect(light.border).toBe('#dfe5e8');
    expect(dark.primary).toBe('#9fc2d8');
  });
});
