import { DESIGN_ARTBOARD } from '@shotx/shared';

/**
 * Pointer geometry of the designer (ADR 0013): moving with smart guides, resizing with the 8
 * handles (in the element's own rotated frame), rotating. Everything is in design units.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RotatedBox extends Box {
  rotation: number;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const rad = (deg: number) => (deg * Math.PI) / 180;

/** The axis-aligned bounds of a box rotated about its centre. */
export function rotatedBounds(b: RotatedBox): Box {
  if (b.rotation === 0) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const t = rad(b.rotation);
  const cos = Math.abs(Math.cos(t));
  const sin = Math.abs(Math.sin(t));
  const w = b.w * cos + b.h * sin;
  const h = b.w * sin + b.h * cos;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The bounds of several boxes (null for none). */
export function unionBounds(boxes: readonly RotatedBox[]): Box | null {
  if (boxes.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes.map(rotatedBounds)) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface Guide {
  axis: 'x' | 'y';
  /** Position of the guide line, design units. */
  at: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * Smart guides: moves `box` by (dx, dy), then snaps its left/centre/right and top/middle/bottom
 * to the artboard's edges and centre and to the other elements' edges and centres when within
 * `threshold`. Returns the snapped delta and the guide lines to draw.
 */
export function snapMove(
  box: Box,
  dx: number,
  dy: number,
  others: readonly Box[],
  threshold: number,
): SnapResult {
  const xs = [0, DESIGN_ARTBOARD.width / 2, DESIGN_ARTBOARD.width];
  const ys = [0, DESIGN_ARTBOARD.height / 2, DESIGN_ARTBOARD.height];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const moved = { x: box.x + dx, y: box.y + dy };
  const best = (edges: number[], targets: number[]) => {
    let delta: number | null = null;
    let at = 0;
    for (const edge of edges) {
      for (const target of targets) {
        const d = target - edge;
        if (Math.abs(d) <= threshold && (delta === null || Math.abs(d) < Math.abs(delta))) {
          delta = d;
          at = target;
        }
      }
    }
    return delta === null ? null : { delta, at };
  };
  const sx = best([moved.x, moved.x + box.w / 2, moved.x + box.w], xs);
  const sy = best([moved.y, moved.y + box.h / 2, moved.y + box.h], ys);
  const guides: Guide[] = [];
  if (sx !== null) guides.push({ axis: 'x', at: sx.at });
  if (sy !== null) guides.push({ axis: 'y', at: sy.at });
  return { dx: dx + (sx?.delta ?? 0), dy: dy + (sy?.delta ?? 0), guides };
}

/**
 * Resizes a (possibly rotated) box by dragging `handle` by (dx, dy) in artboard space. The pointer
 * delta is turned into the box's own frame, the side opposite the handle stays where it is, and
 * `keepRatio` (Shift) keeps the aspect ratio. Sizes never go below `minSize`.
 */
export function resizeBox(
  start: RotatedBox,
  handle: Handle,
  dx: number,
  dy: number,
  keepRatio: boolean,
  minSize = 1,
): Box {
  const t = rad(start.rotation);
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // Into the box's frame.
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  let w = Math.max(minSize, start.w + sx * lx);
  let h = Math.max(minSize, start.h + sy * ly);
  if (keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if (sx !== 0 && sy !== 0) {
      if (w / start.w >= h / start.h) h = w / ratio;
      else w = h * ratio;
    } else if (sx !== 0) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
    w = Math.max(minSize, w);
    h = Math.max(minSize, h);
  }
  // The anchor (opposite side or corner, or the centre line) stays fixed in artboard space.
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  const ax = (-sx * start.w) / 2;
  const ay = (-sy * start.h) / 2;
  const anchorX = cx + ax * cos - ay * sin;
  const anchorY = cy + ax * sin + ay * cos;
  const bx = (sx * w) / 2;
  const by = (sy * h) / 2;
  const ncx = anchorX + bx * cos - by * sin;
  const ncy = anchorY + bx * sin + by * cos;
  return { x: ncx - w / 2, y: ncy - h / 2, w, h };
}

/**
 * The rotation (degrees, -180..180, clockwise; 0 = the rotate handle straight up) that points
 * from the box centre to (px, py). `snap` (Shift) rounds to 15 degrees.
 */
export function rotationTo(box: Box, px: number, py: number, snap: boolean): number {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
  if (snap) deg = Math.round(deg / 15) * 15;
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return Math.round(deg * 10) / 10;
}

/** Whether two axis-aligned boxes overlap (marquee selection). */
export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
