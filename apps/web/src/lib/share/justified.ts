/**
 * Justified rows for the share gallery (ADR 0011: thumbnails in their original aspect ratio, no
 * square crop). Items fill a row at a target height until it is full, then the row is scaled so
 * it spans the width exactly; the last row keeps the target height (it isn't stretched). Pure,
 * so the layout is the same on every render and easy to test.
 */

/** Ratio used when a file has no dimensions (videos still processing, old files): 4:3. */
export const FALLBACK_RATIO = 4 / 3;
/** Never stretch a row (e.g. one very wide panorama) beyond this many times the target height. */
const MAX_HEIGHT_FACTOR = 1.6;

export interface Sized {
  width: number | null;
  height: number | null;
}

export function aspectRatio(item: Sized): number {
  return item.width !== null && item.height !== null && item.width > 0 && item.height > 0
    ? item.width / item.height
    : FALLBACK_RATIO;
}

export interface JustifiedRow {
  /** Index of the row's first item. */
  start: number;
  /** Width of each item, px (the row's height times its ratio). */
  widths: number[];
  height: number;
}

export function justifiedRows(
  ratios: readonly number[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
): JustifiedRow[] {
  const rows: JustifiedRow[] = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < ratios.length; i++) {
    sum += ratios[i] as number;
    const count = i - start + 1;
    const gaps = gap * (count - 1);
    if (sum * targetHeight + gaps >= containerWidth) {
      const height = Math.min((containerWidth - gaps) / sum, targetHeight * MAX_HEIGHT_FACTOR);
      rows.push({
        start,
        height,
        widths: ratios.slice(start, i + 1).map((r) => r * height),
      });
      start = i + 1;
      sum = 0;
    }
  }
  if (start < ratios.length) {
    rows.push({
      start,
      height: targetHeight,
      widths: ratios.slice(start).map((r) => r * targetHeight),
    });
  }
  return rows;
}

/** Row height to aim for: smaller on phones (about three photos a row), larger on wide screens. */
export function targetRowHeight(containerWidth: number): number {
  return containerWidth < 640 ? 132 : containerWidth < 1024 ? 180 : 220;
}
