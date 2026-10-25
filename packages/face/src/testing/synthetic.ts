import sharp from 'sharp';
import type { PixelRect, Size } from '../types';
import { mulberry32 } from './random';
import type { Pose, SyntheticWorld } from './world';

/**
 * Synthetic images: every face is a square in its person's colour with a dark eye bar whose
 * horizontal position encodes the pose. They survive JPEG, resizing and cropping, so the real
 * image pipeline can run against them.
 */
export interface SceneFace {
  personId: string;
  pose: Pose;
  left: number;
  top: number;
  size: number;
}

export interface Scene extends Size {
  faces: SceneFace[];
}

export interface DetectedFace {
  personId: string;
  pose: Pose;
  box: PixelRect;
}

const BAR_TOP = 0.3;
const BAR_HEIGHT = 0.12;
const BAR_WIDTH = 0.5;
const BAR_LEFT: Record<Pose, number> = { front: 0.25, left: 0.08, right: 0.42 };

const MIN_SATURATION = 45;
const MAX_DARK = 50;
const MIN_SIDE = 6;
const MIN_FILL = 0.5;

export async function renderScene(
  world: SyntheticWorld,
  scene: Scene,
  seed: number,
): Promise<Buffer> {
  const { width, height } = scene;
  const data = Buffer.alloc(width * height * 3);
  const random = mulberry32(seed);
  // Grey gradient with a little noise: no saturation, so the background never reads as a face.
  for (let y = 0; y < height; y++) {
    const base = 105 + (50 * y) / height;
    for (let x = 0; x < width; x++) {
      const value = Math.round(base + (random() - 0.5) * 4);
      const i = (y * width + x) * 3;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
  }
  for (const face of scene.faces) {
    const [r, g, b] = world.person(face.personId).color;
    fill(data, width, { left: face.left, top: face.top, width: face.size, height: face.size }, [
      r,
      g,
      b,
    ]);
    fill(
      data,
      width,
      {
        left: face.left + Math.round(BAR_LEFT[face.pose] * face.size),
        top: face.top + Math.round(BAR_TOP * face.size),
        width: Math.max(1, Math.round(BAR_WIDTH * face.size)),
        height: Math.max(1, Math.round(BAR_HEIGHT * face.size)),
      },
      [0, 0, 0],
    );
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A phone selfie: one large face in the middle of a portrait frame. */
export function selfieScene(personId: string, pose: Pose): Scene {
  const width = 960;
  const height = 1280;
  const size = Math.round(width * 0.55);
  const left = Math.round((width - size) / 2);
  return { width, height, faces: [{ personId, pose, left, top: Math.round(height * 0.3), size }] };
}

function fill(
  data: Buffer,
  stride: number,
  rect: PixelRect,
  [r, g, b]: readonly [number, number, number],
): void {
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const i = (y * stride + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}

/** A horizontal run of saturated pixels, with the colour sums of its pixels. */
interface Run {
  y: number;
  x0: number;
  x1: number;
  r: number;
  g: number;
  b: number;
}

interface Component {
  left: number;
  right: number;
  top: number;
  bottom: number;
  count: number;
  r: number;
  g: number;
  b: number;
}

/** Finds the synthetic faces in an image: connected regions of saturated pixels. */
export async function detectSyntheticFaces(
  world: SyntheticWorld,
  bytes: Uint8Array,
): Promise<{ size: Size; faces: DetectedFace[] }> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // Label runs row by row and union each run with the runs it touches in the previous row.
  const runs: Run[] = [];
  const parent: number[] = [];
  const find = (id: number): number => {
    let root = id;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[id] !== root) {
      const next = parent[id]!;
      parent[id] = root;
      id = next;
    }
    return root;
  };
  let previous: number[] = [];
  for (let y = 0; y < height; y++) {
    const current: number[] = [];
    let run: Run | undefined;
    for (let x = 0; x <= width; x++) {
      const i = (y * width + x) * channels;
      const saturated =
        x < width &&
        Math.max(data[i]!, data[i + 1]!, data[i + 2]!) -
          Math.min(data[i]!, data[i + 1]!, data[i + 2]!) >=
          MIN_SATURATION;
      if (saturated) {
        run ??= { y, x0: x, x1: x, r: 0, g: 0, b: 0 };
        run.x1 = x + 1;
        run.r += data[i]!;
        run.g += data[i + 1]!;
        run.b += data[i + 2]!;
      } else if (run) {
        current.push(runs.length);
        parent.push(runs.length);
        runs.push(run);
        run = undefined;
      }
    }
    let p = 0;
    for (const id of current) {
      const { x0, x1 } = runs[id]!;
      while (p < previous.length && runs[previous[p]!]!.x1 <= x0) p++;
      for (let q = p; q < previous.length && runs[previous[q]!]!.x0 < x1; q++) {
        parent[find(previous[q]!)] = find(id);
      }
    }
    previous = current;
  }

  const components = new Map<number, Component>();
  for (const [id, run] of runs.entries()) {
    const root = find(id);
    const c = components.get(root);
    if (!c) {
      components.set(root, {
        left: run.x0,
        right: run.x1,
        top: run.y,
        bottom: run.y + 1,
        count: run.x1 - run.x0,
        r: run.r,
        g: run.g,
        b: run.b,
      });
      continue;
    }
    c.left = Math.min(c.left, run.x0);
    c.right = Math.max(c.right, run.x1);
    c.top = Math.min(c.top, run.y);
    c.bottom = Math.max(c.bottom, run.y + 1);
    c.count += run.x1 - run.x0;
    c.r += run.r;
    c.g += run.g;
    c.b += run.b;
  }

  const faces: DetectedFace[] = [];
  for (const c of components.values()) {
    const box = { left: c.left, top: c.top, width: c.right - c.left, height: c.bottom - c.top };
    if (box.width < MIN_SIDE || box.height < MIN_SIDE) continue;
    if (c.count < MIN_FILL * box.width * box.height) continue;
    const person = world.personByColor([c.r / c.count, c.g / c.count, c.b / c.count]);
    if (!person) continue;
    faces.push({ personId: person.id, pose: poseOf(data, width, channels, box), box });
  }
  return { size: { width, height }, faces };
}

/** Reads the pose from where the dark eye bar sits inside the face box. */
function poseOf(data: Buffer, width: number, channels: number, box: PixelRect): Pose {
  let sumX = 0;
  let count = 0;
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      const i = (y * width + x) * channels;
      if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < MAX_DARK) {
        sumX += x;
        count++;
      }
    }
  }
  if (count === 0) return 'front';
  const position = (sumX / count - box.left + 0.5) / box.width;
  return position < 0.42 ? 'left' : position > 0.58 ? 'right' : 'front';
}
