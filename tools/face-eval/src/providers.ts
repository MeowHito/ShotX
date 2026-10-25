import { S3Client } from '@aws-sdk/client-s3';
import {
  createLocalRekognitionLimiters,
  type FaceProvider,
  InlineTempImageStore,
  RekognitionFaceProvider,
  S3TempImageStore,
  type SmallFaceDetector,
  type TempImageStore,
} from '@shotx/face';
import {
  FakeFaceProvider,
  MemoryTempImageStore,
  SyntheticSmallFaceDetector,
  SyntheticWorld,
} from '@shotx/face/testing';
import type { FaceConfig } from '@shotx/shared';
import type { Dataset } from './dataset';

export const PROVIDERS = ['fake', 'rekognition'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** The flag that must accompany `--provider rekognition`. */
export const AWS_ACKNOWLEDGEMENT = 'i-understand-this-calls-aws';

export interface ProviderSetup {
  name: ProviderName;
  provider: FaceProvider;
  tempStore: TempImageStore;
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

export interface ProviderRequest {
  name: string;
  acknowledged: boolean;
  dataset: Dataset;
  config: FaceConfig;
  /** S3 bucket for temporary index images (Rekognition only); inline images are capped at 5 MB. */
  tempBucket?: string | undefined;
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
    const tempStore = new MemoryTempImageStore();
    return {
      name,
      provider: new FakeFaceProvider(world, tempStore),
      tempStore,
      smallFaceDetector: new SyntheticSmallFaceDetector(world),
      description: 'FakeFaceProvider (deterministic synthetic similarity model, no AWS calls)',
    };
  }

  const { rekognition } = request.config;
  // One process, so in-process limiters keep it under the per-operation TPS.
  const provider = RekognitionFaceProvider.create(
    rekognition,
    'background',
    createLocalRekognitionLimiters(rekognition),
  );
  const tempStore: TempImageStore = request.tempBucket
    ? new S3TempImageStore(new S3Client({ region: rekognition.region }), request.tempBucket)
    : new InlineTempImageStore();
  return {
    name,
    provider,
    tempStore,
    // No YuNet detector is wired yet: "signal" tiling relies on Rekognition's unindexed reasons.
    smallFaceDetector: undefined,
    description: `Amazon Rekognition (${rekognition.region}), ${
      request.tempBucket
        ? `index images via s3://${request.tempBucket}/tmp/index/`
        : 'inline index images (≤ 5 MB)'
    }`,
  };
}
