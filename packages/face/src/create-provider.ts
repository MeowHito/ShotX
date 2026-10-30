import type { AwsClientConfig, FaceConfig } from '@shotx/shared';
import type { FaceProvider } from './provider';
import type { RedisScriptClient } from './redis-token-bucket';
import { createRedisRekognitionLimiters, type RekognitionProfile } from './rekognition-limits';
import { RekognitionFaceProvider } from './rekognition-provider';
import { OnnxFaceEngine } from './self-hosted/engine';
import { type PgPoolLike, PgFaceVectorStore } from './self-hosted/pg-vector-store';
import { SelfHostedFaceProvider } from './self-hosted/provider';

export interface FaceProviderDeps {
  /** `interactive` in the api (face search), `background` in the worker. */
  profile: RekognitionProfile;
  /** The primary database (`face_vectors`); used with FACE_PROVIDER=self-hosted. */
  pool: PgPoolLike;
  /** Shared token buckets; used with FACE_PROVIDER=rekognition. */
  redis: RedisScriptClient;
  /** REKOGNITION_* client settings; required with FACE_PROVIDER=rekognition, else null. */
  rekognitionClient: AwsClientConfig | null;
}

export interface ConfiguredFaceProvider {
  provider: FaceProvider;
  /**
   * Loads and checks the model files (self-hosted) so a missing or altered file fails at start-up
   * rather than on the first scan; a no-op for Rekognition. Call it when face search is enabled.
   */
  warmUp(): Promise<void>;
  /** For the start-up log line: the backend and model, never a key. */
  summary: string;
}

/** The FaceProvider FACE_PROVIDER selects (ADR 0009 section 1). */
export function createFaceProvider(
  config: FaceConfig,
  deps: FaceProviderDeps,
): ConfiguredFaceProvider {
  if (config.provider === 'rekognition') {
    if (deps.rekognitionClient === null) {
      throw new Error('FACE_PROVIDER=rekognition needs the REKOGNITION_* client settings');
    }
    return {
      provider: RekognitionFaceProvider.create(
        config.rekognition,
        deps.profile,
        createRedisRekognitionLimiters(deps.redis, config.rekognition, deps.profile),
        deps.rekognitionClient,
      ),
      warmUp: () => Promise.resolve(),
      summary: `face provider: rekognition (${config.rekognition.region})`,
    };
  }
  const { selfHosted } = config;
  const engine = OnnxFaceEngine.fromConfig(config);
  return {
    provider: new SelfHostedFaceProvider({
      engine,
      store: new PgFaceVectorStore(deps.pool, selfHosted.hnsw),
      maxImageBytes: config.index.maxBytes,
    }),
    warmUp: () => engine.warmUp(),
    summary: `face provider: self-hosted (${selfHosted.detectorModel} + ${selfHosted.model})`,
  };
}
