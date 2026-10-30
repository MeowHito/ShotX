import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One ONNX graph with a single float32 input, run with one tensor at a time. */
export interface TensorSession {
  /** Runs the graph; every float32 output by name. */
  run(input: Float32Array, dims: readonly number[]): Promise<Record<string, Float32Array>>;
}

/** A model file whose bytes differ from the registry's SHA-256 (ADR 0009 section 2). */
export class ModelChecksumError extends Error {
  override readonly name = 'ModelChecksumError';
  constructor(
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Model file ${file} has SHA-256 ${actual}, expected ${expected}`);
  }
}

export class ModelFileMissingError extends Error {
  override readonly name = 'ModelFileMissingError';
  constructor(readonly path: string) {
    super(
      `Model file ${path} not found. Run \`pnpm --filter @shotx/face models:download\` and set FACE_MODEL_DIR.`,
    );
  }
}

/** Reads a model file and checks it against the registry hash before anything parses it. */
export async function readModelFile(
  dir: string,
  model: { file: string; sha256: string },
): Promise<Uint8Array> {
  const path = join(dir, model.file);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ModelFileMissingError(path);
    throw error;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== model.sha256) throw new ModelChecksumError(model.file, model.sha256, actual);
  return bytes;
}

export interface OnnxSessionOptions {
  /** Intra-op threads (FACE_ONNX_THREADS). */
  threads: number;
}

/**
 * Opens a checked model file with ONNX Runtime (CPU). onnxruntime-node is imported here, on first
 * use, so processes that never run a model (and their tests) don't load the native binding.
 */
export async function openOnnxSession(
  bytes: Uint8Array,
  options: OnnxSessionOptions,
): Promise<TensorSession> {
  // ONNX Runtime 1.30+ uploads usage telemetry over HTTPS unless told not to; nothing about our
  // inference leaves the VPS (ADR 0009). Read when the native library loads, so set it first.
  process.env.ORT_DISABLE_TELEMETRY = '1';
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['cpu'],
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    // 3 = errors only: YuNet's graph lists an initializer as an input, which ORT warns about.
    logSeverityLevel: 3,
  });
  const [inputName] = session.inputNames;
  if (inputName === undefined) throw new Error('Model has no input');
  return {
    async run(input, dims) {
      const results = await session.run({
        [inputName]: new ort.Tensor('float32', input, [...dims]),
      });
      const out: Record<string, Float32Array> = {};
      for (const [name, tensor] of Object.entries(results)) {
        if (tensor.type !== 'float32') throw new Error(`Output ${name} is ${tensor.type}`);
        out[name] = tensor.data as Float32Array;
      }
      return out;
    },
  };
}
