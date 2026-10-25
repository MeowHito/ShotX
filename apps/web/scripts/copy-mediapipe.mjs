// Copies MediaPipe's wasm runtime from node_modules into public/mediapipe/dist so the share
// page loads it from our own origin (FACE_DETECTOR_WASM_BASE_PATH, default /mediapipe/dist),
// never from a CDN. Runs before `next dev` and `next build`. The directory is named `dist` so the
// repository's existing ignore rules (git, Prettier, ESLint: `dist/`) skip the generated copy.
//
// The face detector model (FACE_DETECTOR_MODEL_PATH, default
// /mediapipe/blaze_face_short_range.tflite) is not on npm: deployment provides it (see the
// Phase 3 report). Without it the quality gate skips face checks and the API's
// NO_FACE_DETECTED stays the backstop.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve('@mediapipe/tasks-vision'));
const source = path.join(packageDir, 'wasm');
const target = path.join(import.meta.dirname, '..', 'public', 'mediapipe', 'dist');

mkdirSync(target, { recursive: true });
const files = readdirSync(source).filter((name) => /^vision_wasm_.*\.(js|wasm)$/.test(name));
if (files.length === 0) throw new Error(`copy-mediapipe: no wasm files in ${source}`);
for (const name of files) copyFileSync(path.join(source, name), path.join(target, name));
