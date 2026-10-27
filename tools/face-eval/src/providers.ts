import {
  createLocalRekognitionLimiters,
  type FaceProvider,
  REKOGNITION_INLINE_MAX_BYTES,
  RekognitionFaceProvider,
  type SmallFaceDetector,
} from '@shotx/face';
import { FakeFaceProvider, SyntheticSmallFaceDetector, SyntheticWorld } from '@shotx/face/testing';
import {
  type AwsClientConfig,
  type Env,
  type FaceConfig,
  isAwsEndpointHost,
  loadRekognitionClientConfig,
} from '@shotx/shared';
import type { Dataset } from './dataset';
import { type IndexOption, indexKey, indexKeyWithoutSize } from './evaluate';

export const PROVIDERS = ['fake', 'rekognition'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** The flag that must accompany `--provider rekognition`. */
export const AWS_ACKNOWLEDGEMENT = 'i-understand-this-calls-aws';

/** Environment variables AWS SDK v3 applies to a Rekognition client without an explicit endpoint. */
const IMPLICIT_ENDPOINT_ENV = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_REKOGNITION'] as const;

export interface ProviderSetup {
  name: ProviderName;
  /** The provider for one index option; see `EvaluationInput.providerFor`. */
  providerFor: (option: IndexOption) => FaceProvider;
  collectionKey: (option: IndexOption) => string;
  /** Largest image the provider accepts. */
  maxImageBytes: number;
  smallFaceDetector: SmallFaceDetector | undefined;
  description: string;
}

/**
 * Refuses real Rekognition unless explicitly acknowledged: it costs money, needs AWS credentials
 * and sends the volunteers' faces to AWS.
 */
export function assertProviderAllowed(name: string, acknowledged: boolean): ProviderName {
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new Error(`Unknown provider "${name}". Use one of: ${PROVIDERS.join(', ')}`);
  }
  if (name === 'rekognition' && !acknowledged) {
    throw new Error(
      `--provider rekognition calls Amazon Rekognition (billed, needs AWS credentials, uploads the ` +
        `volunteers' photos and selfies to AWS). Add --${AWS_ACKNOWLEDGEMENT} to run it.`,
    );
  }
  return name as ProviderName;
}

/**
 * The Rekognition client settings for an evaluation (ADR 0008 section 1), stricter than the
 * services: face-eval measures real Rekognition, so it needs the evaluation account's own keys
 * (never the default credential chain, which on a laptop is whatever profile is active) and an
 * AWS endpoint (never LocalStack, and never AWS_ENDPOINT_URL from a sourced `.env`).
 */
export function evaluationClientConfig(env: Env): AwsClientConfig {
  const client = loadRekognitionClientConfig(env);
  if (client.credentials === null) {
    throw new Error(
      'Set REKOGNITION_ACCESS_KEY_ID and REKOGNITION_SECRET_ACCESS_KEY to the approved evaluation ' +
        "account's keys: face-eval never uses the default AWS credential chain.",
    );
  }
  if (client.endpointUrl !== null) {
    if (!isAwsEndpointHost(new URL(client.endpointUrl).hostname)) {
      throw new Error(
        `REKOGNITION_ENDPOINT_URL points to ${new URL(client.endpointUrl).host}, which is not AWS. ` +
          'face-eval measures real Rekognition: unset it (the local .env points it at LocalStack).',
      );
    }
  } else {
    const leaking = IMPLICIT_ENDPOINT_ENV.filter((name) => (env[name] ?? '') !== '');
    if (leaking.length > 0) {
      throw new Error(
        `Unset ${leaking.join(' and ')}: AWS SDK v3 would send Rekognition there instead of to ` +
          `${client.region} (the local .env points AWS_ENDPOINT_URL at LocalStack).`,
      );
    }
  }
  return client;
}

export interface ProviderRequest {
  name: string;
  acknowledged: boolean;
  dataset: Dataset;
  config: FaceConfig;
  /** Read only with `--provider rekognition`: the REKOGNITION_* client settings. */
  env: Env;
  /** The largest FACE_INDEX_MAX_BYTES in the grid. */
  maxIndexBytes: number;
}

export function createProvider(request: ProviderRequest): ProviderSetup {
  const name = assertProviderAllowed(request.name, request.acknowledged);
  if (name === 'fake') {
    const synthetic = request.dataset.synthetic;
    if (!synthetic) {
      throw new Error(
        'The fake provider only understands synthetic datasets (made by `face-eval synth`). ' +
          `Real photos need --provider rekognition --${AWS_ACKNOWLEDGEMENT}.`,
      );
    }
    const world = new SyntheticWorld(synthetic.world);
    // Above 5 MiB only to replay the old 15 MiB S3 path for comparison.
    const maxImageBytes = Math.max(REKOGNITION_INLINE_MAX_BYTES, request.maxIndexBytes);
    return {
      name,
      providerFor: () => new FakeFaceProvider(world, { maxImageBytes }),
      collectionKey: indexKeyWithoutSize,
      maxImageBytes,
      smallFaceDetector: new SyntheticSmallFaceDetector(world),
      description: 'FakeFaceProvider (deterministic synthetic similarity model, no AWS calls)',
    };
  }

  if (request.maxIndexBytes > REKOGNITION_INLINE_MAX_BYTES) {
    throw new Error(
      `Rekognition takes images as bytes of at most ${REKOGNITION_INLINE_MAX_BYTES} bytes ` +
        '(ADR 0008 section 5); the S3 path is gone. Compare larger limits with `face-eval encode`.',
    );
  }
  const client = evaluationClientConfig(request.env);
  const { rekognition } = request.config;
  // One process, so in-process limiters keep it under the per-operation TPS.
  const provider = RekognitionFaceProvider.create(
    rekognition,
    'background',
    createLocalRekognitionLimiters(rekognition),
    client,
  );
  return {
    name,
    providerFor: () => provider,
    collectionKey: indexKey,
    maxImageBytes: REKOGNITION_INLINE_MAX_BYTES,
    // No YuNet detector is wired yet: "signal" tiling relies on Rekognition's unindexed reasons.
    smallFaceDetector: undefined,
    description: `Amazon Rekognition (${client.region}${
      client.endpointUrl === null ? '' : `, endpoint ${new URL(client.endpointUrl).host}`
    }), index images as bytes (≤ ${REKOGNITION_INLINE_MAX_BYTES} bytes)`,
  };
}
