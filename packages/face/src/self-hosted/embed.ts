import type { FaceRecognitionModel } from '@shotx/shared';
import { ALIGNED_SIZE } from './align';
import type { TensorSession } from './session';

/**
 * The network input for an aligned 112 × 112 RGB crop: 1 × 3 × 112 × 112 planes in the model's
 * channel order, (value − mean) / std.
 */
export function recognitionInput(
  crop: Uint8Array,
  model: Pick<FaceRecognitionModel, 'channels' | 'mean' | 'std'>,
): Float32Array {
  const plane = ALIGNED_SIZE * ALIGNED_SIZE;
  const input = new Float32Array(3 * plane);
  const order = model.channels === 'rgb' ? [0, 1, 2] : [2, 1, 0];
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * plane + i] = (crop[i * 3 + order[c]!]! - model.mean) / model.std;
    }
  }
  return input;
}

/** Scales a vector to unit length, so cosine similarity is a dot product. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) throw new RangeError('Cannot normalise a zero embedding');
  return vector.map((v) => v / norm);
}

/** The unit-length embedding of an aligned crop. */
export async function embedFace(
  session: TensorSession,
  model: FaceRecognitionModel,
  crop: Uint8Array,
): Promise<Float32Array> {
  const outputs = await session.run(recognitionInput(crop, model), [
    1,
    3,
    ALIGNED_SIZE,
    ALIGNED_SIZE,
  ]);
  const [embedding] = Object.values(outputs);
  if (embedding?.length !== model.dimensions) {
    throw new Error(`Expected a ${model.dimensions}-dimensional embedding`);
  }
  return l2Normalize(embedding);
}

/** Cosine similarity of two unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** The provider's similarity scale: 100 × cosine, clamped to 0–100 (ADR 0009 section 3). */
export function similarityFromCosine(value: number): number {
  return Math.min(100, Math.max(0, value * 100));
}
