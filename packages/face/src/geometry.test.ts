import { describe, expect, it } from 'vitest';
import { countDistinct, iou, tileBoxToImage, tileRects, touchesInnerEdge } from './geometry';
import { mulberry32 } from './testing/random';

describe('tileRects', () => {
  it('returns the whole image for a 1×1 grid', () => {
    expect(tileRects({ width: 600, height: 400 }, 1, 0.15)).toEqual([
      { left: 0, top: 0, width: 600, height: 400 },
    ]);
  });

  it('covers the image with equal tiles that overlap by the requested share', () => {
    const image = { width: 6000, height: 4000 };
    const rects = tileRects(image, 2, 0.15);
    expect(rects).toHaveLength(4);
    for (const rect of rects) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(image.width);
      expect(rect.top + rect.height).toBeLessThanOrEqual(image.height);
    }
    const [first, second, third] = rects;
    expect(first?.left).toBe(0);
    expect(second!.left + second!.width).toBe(image.width);
    expect(third!.top + third!.height).toBe(image.height);
    const overlap = first!.left + first!.width - second!.left;
    expect(overlap / first!.width).toBeCloseTo(0.15, 2);
  });

  it('puts every face narrower than the overlap wholly inside some tile', () => {
    const image = { width: 5000, height: 3333 };
    for (const grid of [2, 3]) {
      const rects = tileRects(image, grid, 0.15);
      const [first, right] = rects;
      const below = rects[grid]!;
      const size = Math.floor(
        Math.min(first!.left + first!.width - right!.left, first!.top + first!.height - below.top),
      );
      const random = mulberry32(grid);
      for (let n = 0; n < 2000; n++) {
        const left = Math.floor(random() * (image.width - size));
        const top = Math.floor(random() * (image.height - size));
        const inside = rects.some(
          (r) =>
            left >= r.left &&
            top >= r.top &&
            left + size <= r.left + r.width &&
            top + size <= r.top + r.height,
        );
        expect(inside).toBe(true);
      }
    }
  });
});

describe('tileBoxToImage', () => {
  it('maps tile ratios to image ratios', () => {
    const box = tileBoxToImage(
      { left: 0.5, top: 0.5, width: 0.1, height: 0.2 },
      { left: 1000, top: 500, width: 2000, height: 1000 },
      { width: 4000, height: 2000 },
    );
    expect(box).toEqual({ left: 0.5, top: 0.5, width: 0.05, height: 0.1 });
  });
});

describe('touchesInnerEdge', () => {
  const image = { width: 1000, height: 1000 };
  const topLeft = { left: 0, top: 0, width: 600, height: 600 };
  const bottomRight = { left: 400, top: 400, width: 600, height: 600 };

  it('flags faces cut by an edge shared with another tile', () => {
    const atRight = { left: 0.9, top: 0.4, width: 0.1, height: 0.1 };
    const atLeft = { left: 0, top: 0.4, width: 0.1, height: 0.1 };
    expect(touchesInnerEdge(atRight, topLeft, image, 0.01)).toBe(true);
    expect(touchesInnerEdge(atLeft, bottomRight, image, 0.01)).toBe(true);
  });

  it('keeps faces at the outer image border or away from edges', () => {
    const atImageBorder = { left: 0, top: 0, width: 0.1, height: 0.1 };
    const inside = { left: 0.4, top: 0.4, width: 0.1, height: 0.1 };
    expect(touchesInnerEdge(atImageBorder, topLeft, image, 0.01)).toBe(false);
    expect(touchesInnerEdge(inside, topLeft, image, 0.01)).toBe(false);
  });
});

describe('iou and countDistinct', () => {
  const a = { left: 0, top: 0, width: 0.2, height: 0.2 };

  it('computes intersection over union', () => {
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { left: 0.5, top: 0.5, width: 0.2, height: 0.2 })).toBe(0);
    expect(iou(a, { left: 0.1, top: 0, width: 0.2, height: 0.2 })).toBeCloseTo(1 / 3);
  });

  it('merges tile duplicates and keeps separate faces', () => {
    const duplicate = { left: 0.01, top: 0.01, width: 0.2, height: 0.2 };
    const other = { left: 0.6, top: 0.6, width: 0.1, height: 0.1 };
    expect(countDistinct([a, duplicate, other], 0.5)).toBe(2);
    expect(countDistinct([], 0.5)).toBe(0);
  });
});
