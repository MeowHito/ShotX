import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, posix, relative, resolve, sep } from 'node:path';
import { POSES, type SceneFace, type World } from '@shotx/face/testing';
import { z } from 'zod';

/**
 * Evaluation dataset on disk:
 *
 *   <dataset>/labels.json            ground truth (LABELS_SCHEMA)
 *   <dataset>/photos/**              event photos (JPEG, PNG or WebP)
 *   <dataset>/selfies/<personId>/*   1–5 selfies per person, used in file-name order
 *   <dataset>/synthetic.json         only in synthetic datasets (SYNTHETIC_SCHEMA)
 */
export const LABELS_FILE = 'labels.json';
export const SYNTHETIC_FILE = 'synthetic.json';
export const PHOTOS_DIR = 'photos';
export const SELFIES_DIR = 'selfies';
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const MAX_SELFIES_PER_PERSON = 5;

/** Pseudonymous ids such as v01: never names, emails or bib numbers. */
const personId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'use a pseudonym such as v01');

/** A path relative to photos/, with forward slashes. */
const photoPath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.includes('\\'), 'must be relative to photos/')
  .refine((path) => path.split('/').every((part) => part !== '..' && part !== '.' && part !== ''), {
    error: 'must not contain empty, "." or ".." segments',
  });

export const LABELS_SCHEMA = z.strictObject({
  version: z.literal(1),
  /** Free text for the report header, e.g. "Sample Run 2026, consent batch A". No personal data. */
  event: z.string().max(200).optional(),
  /** Person → every photo in which a human who knows the person can recognize their face. */
  persons: z.record(personId, z.array(photoPath)).refine((p) => Object.keys(p).length > 0, {
    error: 'at least one person is required',
  }),
});
export type Labels = z.infer<typeof LABELS_SCHEMA>;

const rgb = z.tuple([z.number(), z.number(), z.number()]).readonly();
const sceneFace = z.object({
  personId: z.string(),
  pose: z.enum(POSES),
  left: z.number(),
  top: z.number(),
  size: z.number(),
});
export const SYNTHETIC_SCHEMA = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  world: z.object({
    persons: z.array(z.object({ id: z.string(), color: rgb, selfieGap: z.number() })),
    lookalikes: z.array(z.object({ a: z.string(), b: z.string(), similarity: z.number() })),
  }),
  /** Photo width in pixels, for face sizes as a share of the width. */
  width: z.number().positive(),
  /** Every face drawn in each photo (path relative to photos/). */
  scenes: z.record(z.string(), z.array(sceneFace)),
});
export type SyntheticManifest = z.infer<typeof SYNTHETIC_SCHEMA>;

export interface Photo {
  /** Stable id used as ExternalImageId: Rekognition only allows [a-zA-Z0-9_.\-:]. */
  id: string;
  /** Relative to photos/, with forward slashes. */
  path: string;
}

export interface Person {
  id: string;
  /** Ids of the photos the person appears in. */
  positives: ReadonlySet<string>;
  /** Selfie paths relative to the dataset folder, in the order they are used. */
  selfies: string[];
}

export interface Dataset {
  dir: string;
  event: string | undefined;
  photos: Photo[];
  persons: Person[];
  /** Present only for synthetic datasets; the fake provider needs it. */
  synthetic:
    { seed: number; world: World; width: number; scenes: Record<string, SceneFace[]> } | undefined;
}

export class DatasetError extends Error {
  constructor(
    dir: string,
    readonly problems: string[],
  ) {
    super(`Dataset ${dir} is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'DatasetError';
  }
}

/** Image files under `dir`, relative to it with forward slashes, sorted. */
async function listImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join(posix.sep))
    .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
    .sort();
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function zodProblems(file: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

/**
 * Loads and validates a dataset. Reads labels and lists files, but no image bytes: selfies are read
 * later, one person at a time, by `readSelfies`.
 */
export async function loadDataset(dirArg: string): Promise<Dataset> {
  const dir = resolve(dirArg);
  const problems: string[] = [];

  let labels: Labels | undefined;
  try {
    const parsed = LABELS_SCHEMA.safeParse(await readJson(join(dir, LABELS_FILE)));
    if (parsed.success) labels = parsed.data;
    else problems.push(...zodProblems(LABELS_FILE, parsed.error));
  } catch (error) {
    problems.push(`${LABELS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let synthetic: Dataset['synthetic'];
  const syntheticPath = join(dir, SYNTHETIC_FILE);
  if (
    await stat(syntheticPath).then(
      () => true,
      () => false,
    )
  ) {
    const parsed = SYNTHETIC_SCHEMA.safeParse(await readJson(syntheticPath));
    if (parsed.success) synthetic = parsed.data;
    else problems.push(...zodProblems(SYNTHETIC_FILE, parsed.error));
  }

  const photosDir = join(dir, PHOTOS_DIR);
  const photoPaths = (await isDirectory(photosDir)) ? await listImages(photosDir) : [];
  if (photoPaths.length === 0) problems.push(`${PHOTOS_DIR}/ has no JPEG, PNG or WebP files`);
  const width = String(photoPaths.length).length;
  const photos = photoPaths.map((path, i): Photo => ({
    id: `p${String(i + 1).padStart(width, '0')}`,
    path,
  }));
  const idByPath = new Map(photos.map((photo) => [photo.path, photo.id]));

  const selfiesDir = join(dir, SELFIES_DIR);
  const selfieFolders = (await isDirectory(selfiesDir))
    ? (await readdir(selfiesDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
    : [];

  const persons: Person[] = [];
  if (labels) {
    for (const [id, paths] of Object.entries(labels.persons).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const positives = new Set<string>();
      for (const path of paths) {
        const photoId = idByPath.get(path);
        if (!photoId)
          problems.push(`${LABELS_FILE}: ${id}: ${path} is not an image in ${PHOTOS_DIR}/`);
        else if (positives.has(photoId))
          problems.push(`${LABELS_FILE}: ${id}: ${path} is listed twice`);
        else positives.add(photoId);
      }
      const folder = join(selfiesDir, id);
      const selfies = (await isDirectory(folder))
        ? (await listImages(folder))
            .filter((p) => !p.includes('/'))
            .map((p) => `${SELFIES_DIR}/${id}/${p}`)
        : [];
      if (selfies.length === 0) problems.push(`${SELFIES_DIR}/${id}/ has no selfies`);
      if (selfies.length > MAX_SELFIES_PER_PERSON) {
        problems.push(
          `${SELFIES_DIR}/${id}/ has ${selfies.length} selfies; at most ${MAX_SELFIES_PER_PERSON}`,
        );
      }
      persons.push({ id, positives, selfies });
    }
    for (const folder of selfieFolders) {
      if (!(folder in labels.persons)) {
        problems.push(
          `${SELFIES_DIR}/${folder}/ has no entry in ${LABELS_FILE} (its ground truth is unknown)`,
        );
      }
    }
  }

  if (problems.length > 0) throw new DatasetError(dir, problems);
  return { dir, event: labels?.event, photos, persons, synthetic };
}

export function readPhoto(dataset: Dataset, photo: Photo): Promise<Buffer> {
  return readFile(join(dataset.dir, PHOTOS_DIR, ...photo.path.split('/')));
}

/**
 * Reads a person's first `count` selfies into memory. They are read only from the dataset folder;
 * callers must never write, copy or log them.
 */
export function readSelfies(dataset: Dataset, person: Person, count: number): Promise<Buffer[]> {
  return Promise.all(
    person.selfies.slice(0, count).map((path) => readFile(join(dataset.dir, ...path.split('/')))),
  );
}

/** Counts only, safe to print and to put in reports. */
export function describeDataset(dataset: Dataset) {
  const appearances = dataset.persons.reduce((sum, p) => sum + p.positives.size, 0);
  const labeled = new Set(dataset.persons.flatMap((p) => [...p.positives]));
  return {
    event: dataset.event,
    synthetic: dataset.synthetic !== undefined,
    photos: dataset.photos.length,
    photosWithoutVolunteers: dataset.photos.length - labeled.size,
    persons: dataset.persons.length,
    personsAbsent: dataset.persons.filter((p) => p.positives.size === 0).length,
    appearances,
    selfies: dataset.persons.reduce((sum, p) => sum + p.selfies.length, 0),
  };
}
