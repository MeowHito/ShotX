import { describe, expect, it } from 'vitest';
import { aspectRatio, FALLBACK_RATIO, justifiedRows, targetRowHeight } from './justified';

describe('justified rows (original aspect ratios, ADR 0011)', () => {
  it('fills each row to the width exactly and keeps every ratio', () => {
    const ratios = [1.5, 0.667, 1.5, 1, 1.333, 0.75, 2];
    const rows = justifiedRows(ratios, 360, 132, 4);
    for (const row of rows.slice(0, -1)) {
      const total = row.widths.reduce((a, b) => a + b, 0) + 4 * (row.widths.length - 1);
      expect(total).toBeCloseTo(360, 5);
      row.widths.forEach((w, i) =>
        expect(w / row.height).toBeCloseTo(ratios[row.start + i] ?? 0, 5),
      );
    }
    expect(rows.flatMap((r) => r.widths)).toHaveLength(ratios.length);
  });

  it('leaves the last row at the target height instead of stretching it', () => {
    const rows = justifiedRows([1.5, 1.5, 1.5, 1], 360, 132, 4);
    const last = rows.at(-1);
    expect(last?.height).toBe(132);
    expect(last?.widths).toEqual([198, 132]);
  });

  it('caps very wide rows and falls back to 4:3 without dimensions', () => {
    const [row] = justifiedRows([10], 360, 132, 4);
    expect(row?.height).toBeLessThanOrEqual(132 * 1.6);
    expect(aspectRatio({ width: null, height: null })).toBe(FALLBACK_RATIO);
    expect(aspectRatio({ width: 3000, height: 2000 })).toBe(1.5);
    expect(justifiedRows([], 360, 132, 4)).toEqual([]);
  });

  it('aims for smaller rows on phones', () => {
    expect(targetRowHeight(360)).toBeLessThan(targetRowHeight(1280));
  });
});
