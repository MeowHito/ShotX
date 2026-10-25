import type { BoundingBox, PixelRect, Size } from './types';

/**
 * Splits an image into `grid` × `grid` tiles of equal size. Neighbouring tiles overlap by
 * `overlap` × the tile size, so any face narrower than the overlap lies whole inside some tile.
 */
export function tileRects(image: Size, grid: number, overlap: number): PixelRect[] {
  const columns = spans(image.width, grid, overlap);
  const rows = spans(image.height, grid, overlap);
  return rows.flatMap(([top, height]) =>
    columns.map(([left, width]) => ({ left, top, width, height })),
  );
}

function spans(
  length: number,
  count: number,
  overlap: number,
): Array<[start: number, size: number]> {
  if (count <= 1) return [[0, length]];
  const size = Math.min(length, Math.ceil(length / (count - (count - 1) * overlap)));
  const step = (length - size) / (count - 1);
  return Array.from({ length: count }, (_, i) => [Math.round(i * step), size]);
}

/** Converts a box relative to `tile` into a box relative to the whole image. */
export function tileBoxToImage(box: BoundingBox, tile: PixelRect, image: Size): BoundingBox {
  return {
    left: (tile.left + box.left * tile.width) / image.width,
    top: (tile.top + box.top * tile.height) / image.height,
    width: (box.width * tile.width) / image.width,
    height: (box.height * tile.height) / image.height,
  };
}

/**
 * True when a face found in `tile` reaches a tile edge that lies inside the image. Such a face is
 * cut off; the overlapping neighbour tile, or the full image if the face is large, holds it whole.
 */
export function touchesInnerEdge(
  box: BoundingBox,
  tile: PixelRect,
  image: Size,
  epsilon: number,
): boolean {
  return (
    (tile.left > 0 && box.left <= epsilon) ||
    (tile.left + tile.width < image.width && box.left + box.width >= 1 - epsilon) ||
    (tile.top > 0 && box.top <= epsilon) ||
    (tile.top + tile.height < image.height && box.top + box.height >= 1 - epsilon)
  );
}

export function iou(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const overlap = width * height;
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

/** Counts faces, merging boxes that overlap by at least `threshold` IoU (tile duplicates). */
export function countDistinct(boxes: readonly BoundingBox[], threshold: number): number {
  const kept: BoundingBox[] = [];
  for (const box of [...boxes].sort((a, b) => b.width * b.height - a.width * a.height)) {
    if (kept.every((other) => iou(box, other) < threshold)) kept.push(box);
  }
  return kept.length;
}
