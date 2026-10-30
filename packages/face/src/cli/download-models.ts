/**
 * Fetches the face model files into FACE_MODEL_DIR and checks every byte against the registry's
 * SHA-256 (ADR 0009 section 2). Files already present with the right hash are kept.
 *
 *   pnpm --filter @shotx/face models:download            the models FACE_DETECTOR_MODEL and
 *                                                        FACE_MODEL select (defaults: YuNet, SFace)
 *   pnpm --filter @shotx/face models:download --all      every model in the registry (face-eval)
 *   ... --dir <path>                                     instead of FACE_MODEL_DIR / .models/face
 *
 * Model files are never committed (.models/ is git-ignored).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  FACE_DETECTOR_MODELS,
  FACE_RECOGNITION_MODELS,
  type FaceDetectorModel,
  type FaceRecognitionModel,
  loadFaceConfig,
} from '@shotx/shared';

type Entry = FaceDetectorModel | FaceRecognitionModel;

/** `<repo>/.models/face`, next to the workspace root, for when FACE_MODEL_DIR is unset. */
export const DEFAULT_MODEL_DIR = resolve(import.meta.dirname, '../../../../.models/face');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function present(path: string, entry: Entry): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === entry.sha256;
  } catch {
    return false;
  }
}

export async function downloadModel(dir: string, id: string, entry: Entry): Promise<void> {
  const path = join(dir, entry.file);
  const label = `${id} (${entry.licence}${entry.production ? '' : ', not approved for production'})`;
  if (await present(path, entry)) {
    console.log(`ok       ${label}`);
    return;
  }
  const response = await fetch(entry.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status} from ${entry.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== entry.sha256 || bytes.length !== entry.bytes) {
    throw new Error(
      `${id}: downloaded ${bytes.length} bytes with SHA-256 ${actual}; the registry pins ${entry.bytes} bytes, ${entry.sha256}. Nothing was written.`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path).catch(async (error: unknown) => {
    await rm(partial, { force: true });
    throw error;
  });
  console.log(`fetched  ${label}`);
  if (!entry.production) console.log(`         ${entry.note}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { all: { type: 'boolean', default: false }, dir: { type: 'string' } },
  });
  const config = loadFaceConfig(process.env).selfHosted;
  const dir = resolve(values.dir ?? config.modelDir ?? DEFAULT_MODEL_DIR);
  const wanted: [string, Entry][] = values.all
    ? [...Object.entries(FACE_DETECTOR_MODELS), ...Object.entries(FACE_RECOGNITION_MODELS)]
    : [
        [config.detectorModel, FACE_DETECTOR_MODELS[config.detectorModel]],
        [config.model, FACE_RECOGNITION_MODELS[config.model]],
      ];
  console.log(`Face models in ${dir}`);
  for (const [id, entry] of wanted) await downloadModel(dir, id, entry);
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
