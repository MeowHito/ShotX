'use client';

import { useMemo, useSyncExternalStore } from 'react';

/**
 * Chart colours (the project's data-viz standard). Categorical slots in a fixed order, never
 * cycled: slot 1 (blue) is income, slot 2 (orange) is expenses; profit uses slot 1 when positive
 * and the reserved critical red when negative (always with a minus sign and a label). Dark mode
 * selects its own steps rather than inverting the light ones. Checked with the data-viz palette
 * validator against the admin card surface (--background: #ffffff light, #0d1114 dark): every
 * pair passes lightness band, chroma, CVD, normal-vision and 3:1 contrast. The dark critical red
 * is not the --destructive text token (#f97066 is too light for a mark: OKLCH L 0.71).
 */
export const CHART_PALETTE = {
  light: { income: '#2a78d6', expense: '#eb6834', critical: '#b42318' },
  dark: { income: '#3987e5', expense: '#d95926', critical: '#e34948' },
} as const;

export type ColorScheme = keyof typeof CHART_PALETTE;

/** The admin's text and surface tokens (packages/ui styles.css), used when CSS can't be read. */
const TOKEN_FALLBACK: Record<ColorScheme, ChartTokens> = {
  light: {
    text: '#111820',
    muted: '#59636a',
    grid: '#dfe5e8',
    surface: '#ffffff',
    popover: '#ffffff',
  },
  dark: {
    text: '#f5f7f8',
    muted: '#aab4bb',
    grid: '#293138',
    surface: '#0d1114',
    popover: '#141a1f',
  },
};

export interface ChartTokens {
  /** Legend, direct labels and tooltip text: --foreground. */
  text: string;
  /** Axis labels: --muted-foreground. */
  muted: string;
  /** Recessive grid and axis lines: --border. */
  grid: string;
  /** The card behind the chart: --background (also the 1 px separator around each bar). */
  surface: string;
  /** Tooltip background: --popover. */
  popover: string;
}

export interface ChartTheme {
  scheme: ColorScheme;
  series: (typeof CHART_PALETTE)[ColorScheme];
  tokens: ChartTokens;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function currentScheme(): ColorScheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * The device's colour scheme. The admin follows it like the studio does: packages/ui switches
 * its tokens with `@media (prefers-color-scheme: dark)`, so charts do the same.
 */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, currentScheme, () => 'light');
}

function readTokens(scheme: ColorScheme): ChartTokens {
  const fallback = TOKEN_FALLBACK[scheme];
  if (typeof document === 'undefined') return fallback;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, otherwise: string) =>
    style.getPropertyValue(name).trim() || otherwise;
  return {
    text: read('--foreground', fallback.text),
    muted: read('--muted-foreground', fallback.muted),
    grid: read('--border', fallback.grid),
    surface: read('--background', fallback.surface),
    popover: read('--popover', fallback.popover),
  };
}

/** Series colours and text tokens for the current scheme; a new object only when it changes. */
export function useChartTheme(): ChartTheme {
  const scheme = useColorScheme();
  return useMemo(
    () => ({ scheme, series: CHART_PALETTE[scheme], tokens: readTokens(scheme) }),
    [scheme],
  );
}
