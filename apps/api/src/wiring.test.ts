import { latestConsentPolicyVersion } from '@shotx/shared';
import { RekognitionFaceProvider, SelfHostedFaceProvider } from '@shotx/face';
import { describe, expect, it } from 'vitest';
import { testConfig } from './testing/fakes';
import { TEST_SHOTX_AUTH_ENV } from './testing/shotx-auth';
import { apiFaceProvider } from './wiring';

/** The VPS (ADR 0008) with the self-hosted face provider (ADR 0009): no Rekognition keys at all. */
const vps = {
  ...TEST_SHOTX_AUTH_ENV,
  AUTH_PROVIDER: 'shotx',
  APP_STAGE: 'staging',
  TRUSTED_PROXY_ADDRESSES: '172.18.0.2',
  QUEUE_BACKEND: 'bullmq',
  MEDIA_URL_SIGNER: 's3-presign',
  STORAGE_ENDPOINT_URL: 'https://0123456789abcdef.r2.cloudflarestorage.com',
  STORAGE_REGION: 'auto',
  STORAGE_ACCESS_KEY_ID: 'r2key',
  STORAGE_SECRET_ACCESS_KEY: 'r2secret',
  STORAGE_ORIGINALS_CLASS: 'STANDARD',
  CLOUDFRONT_MEDIA_BASE_URL: '',
  CLOUDFRONT_KEY_PAIR_ID: '',
  CLOUDFRONT_PRIVATE_KEY: '',
  REKOGNITION_ACCESS_KEY_ID: '',
  REKOGNITION_SECRET_ACCESS_KEY: '',
  FACE_PROVIDER: 'self-hosted',
};

const pool = {
  query: () => Promise.reject(new Error('unused')),
  connect: () => Promise.reject(new Error('unused')),
};

describe('apiFaceProvider (ADR 0009)', () => {
  it('runs self-hosted off AWS without Rekognition keys, with the matching consent version', () => {
    const config = testConfig(vps);
    expect(config.rekognitionClient).toBeNull();
    expect(config.consent.policyVersion).toBe(latestConsentPolicyVersion('self-hosted'));
    expect(config.face.thresholds).toEqual({ strong: 50, maybe: 36 });
    const face = apiFaceProvider(config, null as never, pool);
    expect(face.provider).toBeInstanceOf(SelfHostedFaceProvider);
    expect(face.summary).toBe('face provider: self-hosted (yunet-2023mar + sface-2021dec)');
  });

  it('refuses a consent version that names another processor than FACE_PROVIDER', () => {
    expect(() => testConfig({ ...vps, CONSENT_POLICY_VERSION: '2026-10-25' })).toThrow(
      /names the rekognition face processor, but FACE_PROVIDER is self-hosted/,
    );
    expect(() => testConfig({ CONSENT_POLICY_VERSION: '2026-10-29' })).toThrow(
      /names the self-hosted face processor, but FACE_PROVIDER is rekognition/,
    );
  });

  it('still builds Rekognition when selected, which then needs its keys off AWS', () => {
    const rekognition = { ...vps, FACE_PROVIDER: 'rekognition', CONSENT_POLICY_VERSION: '' };
    expect(() => testConfig(rekognition)).toThrow(/REKOGNITION_ACCESS_KEY_ID/);
    const config = testConfig({
      ...rekognition,
      REKOGNITION_ACCESS_KEY_ID: 'AKIATESTREKOGNITION0',
      REKOGNITION_SECRET_ACCESS_KEY: 'secret',
    });
    expect(config.consent.policyVersion).toBe('2026-10-25');
    expect(apiFaceProvider(config, null as never, pool).provider).toBeInstanceOf(
      RekognitionFaceProvider,
    );
  });
});
