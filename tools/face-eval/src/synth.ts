import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  mulberry32,
  type Pose,
  renderScene,
  type Scene,
  type SceneFace,
  selfieScene,
  SyntheticWorld,
} from '@shotx/face/testing';
import {
  type Labels,
  LABELS_FILE,
  PHOTOS_DIR,
  SELFIES_DIR,
  SYNTHETIC_FILE,
  type SyntheticManifest,
} from './dataset';

export interface SynthOptions {
  out: string;
  photos: number;
  /** Volunteers with selfies and labels. */
  volunteers: number;
  /** Volunteers who are in no photo: their scans should come back empty. */
  absent: number;
  /** People in the photos without selfies or labels. */
  bystanders: number;
  seed: number;
  width: number;
  height: number;
}

interface SceneKind {
  name: string;
  weight: number;
  faces: [min: number, max: number];
  /** Face width as a share of the image width. */
  size: [min: number, max: number];
}

/**
 * A made-up mix of event shots: portraits, finish-line shots, groups and start-line crowds. Real
 * events differ; the real dataset is what counts.
 */
const KINDS: SceneKind[] = [
  { name: 'portrait', weight: 0.2, faces: [1, 3], size: [0.06, 0.15] },
  { name: 'finish', weight: 0.3, faces: [2, 6], size: [0.03, 0.08] },
  { name: 'group', weight: 0.3, faces: [6, 16], size: [0.02, 0.05] },
  { name: 'crowd', weight: 0.2, faces: [8, 20], size: [0.01, 0.025] },
];
const VOLUNTEER_SHARE = 0.4;
const POSE_WEIGHTS: Array<[Pose, number]> = [
  ['front', 0.6],
  ['left', 0.2],
  ['right', 0.2],
];
const SELFIE_POSES: Pose[] = ['front', 'left', 'right'];
const PLACEMENT_TRIES = 200;

function pick<T>(items: ReadonlyArray<readonly [T, number]>, random: () => number): T {
  let r = random() * items.reduce((sum, [, w]) => sum + w, 0);
  for (const [item, weight] of items) {
    r -= weight;
    if (r < 0) return item;
  }
  return items.at(-1)![0];
}

function between(random: () => number, [min, max]: [number, number]): number {
  return min + random() * (max - min);
}

function overlaps(a: SceneFace, b: SceneFace): boolean {
  const gap = Math.max(8, Math.round(0.1 * Math.max(a.size, b.size)));
  return !(
    a.left + a.size + gap <= b.left ||
    b.left + b.size + gap <= a.left ||
    a.top + a.size + gap <= b.top ||
    b.top + b.size + gap <= a.top
  );
}

/** Builds the scenes without rendering them. Deterministic for a given seed. */
export function planScenes(world: SyntheticWorld, options: Omit<SynthOptions, 'out'>): Scene[] {
  const random = mulberry32(options.seed ^ 0x5eed);
  const present = world.persons.filter((p) => p.id.startsWith('v')).slice(options.absent);
  const bystanders = world.persons.filter((p) => p.id.startsWith('b'));
  const kinds = KINDS.map((k) => [k, k.weight] as const);
  const scenes: Scene[] = [];
  for (let n = 0; n < options.photos; n++) {
    const kind = pick(kinds, random);
    const count = Math.round(between(random, kind.faces));
    const used = new Set<string>();
    const faces: SceneFace[] = [];
    for (let i = 0; i < count; i++) {
      const pool = random() < VOLUNTEER_SHARE ? present : bystanders;
      const candidates = pool.filter((p) => !used.has(p.id));
      if (candidates.length === 0) continue;
      const person = candidates[Math.floor(random() * candidates.length)]!;
      const size = Math.max(12, Math.round(options.width * between(random, kind.size)));
      for (let t = 0; t < PLACEMENT_TRIES; t++) {
        const face: SceneFace = {
          personId: person.id,
          pose: pick(POSE_WEIGHTS, random),
          left: Math.floor(random() * (options.width - size)),
          top: Math.floor(random() * (options.height - size)),
          size,
        };
        if (faces.every((other) => !overlaps(face, other))) {
          faces.push(face);
          used.add(person.id);
          break;
        }
      }
    }
    scenes.push({ width: options.width, height: options.height, faces });
  }
  return scenes;
}

async function prepareOutput(out: string, force: boolean): Promise<void> {
  const entries = await readdir(out).catch(() => [] as string[]);
  if (entries.length === 0) return;
  // Only ever delete a folder that synth itself created.
  const generated = await stat(join(out, SYNTHETIC_FILE)).then(
    () => true,
    () => false,
  );
  if (!force || !generated) {
    throw new Error(
      `${out} is not empty. ${generated ? 'Pass --force to replace it.' : 'Choose an empty folder.'}`,
    );
  }
  await rm(out, { recursive: true });
}

export async function synthesize(
  options: SynthOptions,
  {
    force = false,
    log = () => undefined,
  }: { force?: boolean; log?: (message: string) => void } = {},
): Promise<{ dir: string; photos: number; volunteers: number }> {
  if (options.absent > options.volunteers) throw new RangeError('--absent exceeds --volunteers');
  const out = resolve(options.out);
  await prepareOutput(out, force);
  const world = SyntheticWorld.create({
    volunteers: options.volunteers,
    bystanders: options.bystanders,
    seed: options.seed,
  });
  const { photos, volunteers, absent, bystanders, seed, width, height } = options;
  const settings = { photos, volunteers, absent, bystanders, seed, width, height };
  const scenes = planScenes(world, settings);

  await mkdir(join(out, PHOTOS_DIR), { recursive: true });
  const labels: Labels = {
    version: 1,
    event: `Synthetic event (seed ${options.seed})`,
    persons: Object.fromEntries(
      world.persons.filter((p) => p.id.startsWith('v')).map((p) => [p.id, [] as string[]]),
    ),
  };
  const manifest: SyntheticManifest & { options: typeof settings } = {
    version: 1,
    seed: options.seed,
    world: world.data,
    width: options.width,
    scenes: {},
    options: settings,
  };
  const digits = Math.max(4, String(scenes.length).length);
  for (const [i, scene] of scenes.entries()) {
    const path = `${String(i + 1).padStart(digits, '0')}.jpg`;
    await writeFile(join(out, PHOTOS_DIR, path), await renderScene(world, scene, options.seed + i));
    manifest.scenes[path] = scene.faces;
    for (const face of scene.faces) labels.persons[face.personId]?.push(path);
    if ((i + 1) % 25 === 0) log(`rendered ${i + 1}/${scenes.length} photos`);
  }

  for (const id of Object.keys(labels.persons)) {
    const folder = join(out, SELFIES_DIR, id);
    await mkdir(folder, { recursive: true });
    for (const [n, pose] of SELFIE_POSES.entries()) {
      const bytes = await renderScene(world, selfieScene(id, pose), options.seed * 7919 + n);
      await writeFile(join(folder, `${n + 1}-${pose}.jpg`), bytes);
    }
  }

  await writeFile(join(out, LABELS_FILE), `${JSON.stringify(labels, null, 2)}\n`);
  await writeFile(join(out, SYNTHETIC_FILE), `${JSON.stringify(manifest)}\n`);
  return { dir: out, photos: scenes.length, volunteers: Object.keys(labels.persons).length };
}
