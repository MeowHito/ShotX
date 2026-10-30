import { describe, expect, it } from 'vitest';
import {
  AWS_CLIENT_ENV,
  awsClientOptions,
  configuredEndpointVariables,
  isAwsEndpointHost,
  loadFaceRekognitionClientConfig,
  loadRekognitionClientConfig,
  loadSesClientConfig,
  runsOffAws,
} from './aws-clients';
import { loadEmailConfig } from './billing';
import { faceEncodeFloorBytes, loadFaceConfig, REKOGNITION_INLINE_IMAGE_MAX_BYTES } from './face';

const keys = {
  REKOGNITION_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  REKOGNITION_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const vps = {
  APP_STAGE: 'prod',
  AUTH_PROVIDER: 'shotx',
  NODE_ENV: 'production',
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
};

describe('runsOffAws', () => {
  it('is false on the AWS stacks and true with API-issued tokens or non-AWS storage', () => {
    expect(runsOffAws({})).toBe(false);
    expect(runsOffAws({ AUTH_PROVIDER: 'cognito' })).toBe(false);
    expect(runsOffAws({ AUTH_PROVIDER: 'shotx' })).toBe(true);
    expect(runsOffAws({ AUTH_PROVIDER: 'local' })).toBe(true);
    expect(runsOffAws({ STORAGE_ENDPOINT_URL: 'https://a.r2.cloudflarestorage.com' })).toBe(true);
  });
});

describe('loadRekognitionClientConfig', () => {
  it('on AWS: region from AWS_REGION or ap-southeast-1, the task role', () => {
    expect(loadRekognitionClientConfig({})).toEqual({
      region: 'ap-southeast-1',
      endpointUrl: null,
      credentials: null,
    });
    expect(loadRekognitionClientConfig({ AWS_REGION: 'us-east-1' }).region).toBe('us-east-1');
    expect(loadFaceConfig({ AWS_REGION: 'us-east-1' }).rekognition.region).toBe('us-east-1');
    expect(
      loadFaceConfig({ AWS_REGION: 'us-east-1', REKOGNITION_REGION: 'ap-southeast-1' }).rekognition
        .region,
    ).toBe('ap-southeast-1');
  });

  it('is null for the self-hosted provider (no keys needed), and required for Rekognition', () => {
    expect(loadFaceRekognitionClientConfig(vps)).toBeNull();
    expect(() => loadFaceRekognitionClientConfig({ ...vps, FACE_PROVIDER: 'rekognition' })).toThrow(
      /required off AWS/,
    );
    expect(
      loadFaceRekognitionClientConfig({ ...vps, ...keys, FACE_PROVIDER: 'rekognition' })
        ?.credentials,
    ).not.toBeNull();
    // The values are still validated with the self-hosted provider.
    expect(() =>
      loadFaceRekognitionClientConfig({ ...vps, REKOGNITION_ENDPOINT_URL: 'not a url' }),
    ).toThrow();
  });

  it('off AWS: requires explicit keys and uses them', () => {
    expect(() => loadRekognitionClientConfig(vps)).toThrow(
      /REKOGNITION_ACCESS_KEY_ID and .* are required off AWS/,
    );
    expect(() =>
      loadRekognitionClientConfig({ STORAGE_ENDPOINT_URL: 'https://a.r2.cloudflarestorage.com' }),
    ).toThrow(/required off AWS/);
    const client = loadRekognitionClientConfig({ ...vps, ...keys });
    expect(client).toEqual({
      region: 'ap-southeast-1',
      endpointUrl: null,
      credentials: {
        accessKeyId: keys.REKOGNITION_ACCESS_KEY_ID,
        secretAccessKey: keys.REKOGNITION_SECRET_ACCESS_KEY,
      },
    });
    expect(awsClientOptions(client)).toEqual({
      region: 'ap-southeast-1',
      credentials: {
        accessKeyId: keys.REKOGNITION_ACCESS_KEY_ID,
        secretAccessKey: keys.REKOGNITION_SECRET_ACCESS_KEY,
      },
    });
  });

  it('needs both keys or neither', () => {
    expect(() =>
      loadFaceConfig({ REKOGNITION_ACCESS_KEY_ID: keys.REKOGNITION_ACCESS_KEY_ID }),
    ).toThrow(/set both REKOGNITION_ACCESS_KEY_ID and REKOGNITION_SECRET_ACCESS_KEY, or neither/);
  });

  it('allows an endpoint override only on AWS hosts outside APP_STAGE=local', () => {
    expect(
      loadRekognitionClientConfig({
        ...vps,
        ...keys,
        REKOGNITION_ENDPOINT_URL: 'https://rekognition-fips.us-east-1.amazonaws.com',
      }).endpointUrl,
    ).toBe('https://rekognition-fips.us-east-1.amazonaws.com');
    for (const url of [
      'http://localhost:4566',
      'https://a.r2.cloudflarestorage.com',
      'http://rekognition.ap-southeast-1.amazonaws.com',
    ]) {
      expect(
        () => loadRekognitionClientConfig({ ...vps, ...keys, REKOGNITION_ENDPOINT_URL: url }),
        url,
      ).toThrow(/must be an https AWS endpoint/);
    }
    const local = loadRekognitionClientConfig({
      APP_STAGE: 'local',
      AUTH_PROVIDER: 'local',
      REKOGNITION_ENDPOINT_URL: 'http://localhost:4566',
      REKOGNITION_ACCESS_KEY_ID: 'test',
      REKOGNITION_SECRET_ACCESS_KEY: 'test',
      AWS_ENDPOINT_URL: 'http://localhost:4566',
    });
    expect(awsClientOptions(local)).toEqual({
      region: 'ap-southeast-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('refuses every SDK endpoint variable off AWS outside APP_STAGE=local, naming not echoing', () => {
    for (const key of [
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_REKOGNITION',
      'AWS_ENDPOINT_URL_SES',
      'AWS_ENDPOINT_URL_SESV2',
      'AWS_ENDPOINT_URL_S3',
    ]) {
      let message = '';
      try {
        loadRekognitionClientConfig({ ...vps, ...keys, [key]: 'https://secret-host.example.com' });
      } catch (error) {
        message = String(error);
      }
      expect(message, key).toMatch(new RegExp(`${key} must be unset off AWS`));
      expect(message, key).not.toContain('secret-host');
    }
    expect(() =>
      loadSesClientConfig({
        ...vps,
        EMAIL_PROVIDER: 'ses',
        SES_ACCESS_KEY_ID: keys.REKOGNITION_ACCESS_KEY_ID,
        SES_SECRET_ACCESS_KEY: keys.REKOGNITION_SECRET_ACCESS_KEY,
        AWS_ENDPOINT_URL_SESV2: 'https://x.example.com',
      }),
    ).toThrow(/AWS_ENDPOINT_URL_SESV2 must be unset off AWS/);
    // Empty counts as unset; AWS stacks and LocalStack-style AWS envs are not refused.
    expect(() =>
      loadRekognitionClientConfig({ ...vps, ...keys, AWS_ENDPOINT_URL: '' }),
    ).not.toThrow();
    expect(() =>
      loadRekognitionClientConfig({ AWS_ENDPOINT_URL: 'http://localhost:4566' }),
    ).not.toThrow();
    expect(
      configuredEndpointVariables({
        AWS_ENDPOINT_URL_S3: 'x',
        AWS_ENDPOINTS: 'x',
        AWS_ENDPOINT_URL: '',
      }),
    ).toEqual(['AWS_ENDPOINT_URL_S3']);
  });

  it('requires AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true off AWS outside APP_STAGE=local', () => {
    const { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: _ignored, ...withoutFlag } = vps;
    void _ignored;
    for (const flag of [undefined, 'false']) {
      expect(() =>
        loadRekognitionClientConfig({
          ...withoutFlag,
          ...keys,
          AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: flag,
        }),
      ).toThrow(/AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true is required off AWS/);
    }
    expect(() =>
      loadRekognitionClientConfig({
        ...withoutFlag,
        ...keys,
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'maybe',
      }),
    ).toThrow(/AWS_IGNORE_CONFIGURED_ENDPOINT_URLS/);
    // Not on the AWS stacks, not locally (LocalStack SQS needs AWS_ENDPOINT_URL), not for fake email.
    expect(() => loadRekognitionClientConfig({})).not.toThrow();
    expect(() =>
      loadRekognitionClientConfig({
        APP_STAGE: 'local',
        AUTH_PROVIDER: 'local',
        REKOGNITION_ACCESS_KEY_ID: 'test',
        REKOGNITION_SECRET_ACCESS_KEY: 'test',
      }),
    ).not.toThrow();
    expect(loadSesClientConfig({ ...withoutFlag })).toBeNull();
    // loadFaceConfig only validates.
    expect(() => loadFaceConfig(withoutFlag)).not.toThrow();
  });

  it.each([
    ['REKOGNITION_REGION', 'Singapore'],
    ['REKOGNITION_ENDPOINT_URL', 'rekognition.amazonaws.com'],
    ['REKOGNITION_ACCESS_KEY_ID', 'test'],
    ['REKOGNITION_SECRET_ACCESS_KEY', ' '],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadFaceConfig({ ...vps, ...keys, [key]: value })).toThrow(new RegExp(key));
  });

  it('recognizes AWS endpoint hosts', () => {
    expect(isAwsEndpointHost('rekognition.ap-southeast-1.amazonaws.com')).toBe(true);
    expect(isAwsEndpointHost('rekognition.ap-southeast-1.api.aws')).toBe(true);
    expect(isAwsEndpointHost('amazonaws.com.evil.example')).toBe(false);
    expect(isAwsEndpointHost('localhost')).toBe(false);
  });
});

describe('loadFaceConfig and loadEmailConfig without keys', () => {
  it('need no keys off AWS (deploy and reports never call AWS) but validate the values', () => {
    expect(loadFaceConfig(vps).rekognition.region).toBe('ap-southeast-1');
    expect(loadFaceConfig({ ...vps, REKOGNITION_REGION: 'us-west-2' }).rekognition.region).toBe(
      'us-west-2',
    );
    expect(() =>
      loadFaceConfig({ ...vps, REKOGNITION_ENDPOINT_URL: 'http://localhost:4566' }),
    ).toThrow(/REKOGNITION_ENDPOINT_URL must be an https AWS endpoint/);
    expect(() =>
      loadFaceConfig({ REKOGNITION_ACCESS_KEY_ID: keys.REKOGNITION_ACCESS_KEY_ID }),
    ).toThrow(/or neither/);
    const email = { EMAIL_FROM_ADDRESS: 'a@b.co', EMAIL_PROVIDER: 'ses' };
    expect(loadEmailConfig({ ...vps, ...email }).provider).toBe('ses');
  });
});

describe('loadSesClientConfig', () => {
  const email = { EMAIL_FROM_ADDRESS: 'no-reply@photos.example.com' };
  const sesKeys = {
    SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('is null for the fake provider, and needs no keys then', () => {
    expect(loadSesClientConfig({ ...vps, APP_STAGE: 'staging', ...email })).toBeNull();
  });

  it('uses the task role on AWS and explicit keys off AWS', () => {
    expect(loadSesClientConfig({ APP_STAGE: 'prod', EMAIL_PROVIDER: 'ses', ...email })).toEqual({
      region: 'ap-southeast-1',
      endpointUrl: null,
      credentials: null,
    });
    expect(() => loadSesClientConfig({ ...vps, EMAIL_PROVIDER: 'ses', ...email })).toThrow(
      /SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY are required off AWS/,
    );
    expect(
      loadSesClientConfig({
        ...vps,
        EMAIL_PROVIDER: 'ses',
        SES_REGION: 'ap-southeast-1',
        ...email,
        ...sesKeys,
      }),
    ).toEqual({
      region: 'ap-southeast-1',
      endpointUrl: null,
      credentials: {
        accessKeyId: sesKeys.SES_ACCESS_KEY_ID,
        secretAccessKey: sesKeys.SES_SECRET_ACCESS_KEY,
      },
    });
  });

  it('still validates SES_* with the fake provider', () => {
    expect(() =>
      loadEmailConfig({ APP_STAGE: 'staging', ...email, SES_ENDPOINT_URL: 'nope' }),
    ).toThrow(/SES_ENDPOINT_URL/);
  });

  it('names every service variable', () => {
    expect(AWS_CLIENT_ENV.ses).toEqual({
      region: 'SES_REGION',
      endpointUrl: 'SES_ENDPOINT_URL',
      accessKeyId: 'SES_ACCESS_KEY_ID',
      secretAccessKey: 'SES_SECRET_ACCESS_KEY',
    });
    expect(loadSesClientConfig({ EMAIL_PROVIDER: 'ses' })).not.toBeNull();
  });
});

describe('face index images as bytes (ADR 0008 section 5)', () => {
  it('defaults FACE_INDEX_MAX_BYTES to the 5 MiB Image.Bytes limit and caps it there', () => {
    expect(REKOGNITION_INLINE_IMAGE_MAX_BYTES).toBe(5_242_880);
    expect(loadFaceConfig({}).index.maxBytes).toBe(5_242_880);
    expect(loadFaceConfig({ FACE_INDEX_MAX_BYTES: '4000000' }).index.maxBytes).toBe(4_000_000);
    expect(() => loadFaceConfig({ FACE_INDEX_MAX_BYTES: '5242881' })).toThrow(
      /FACE_INDEX_MAX_BYTES/,
    );
    expect(() => loadFaceConfig({ FACE_INDEX_MAX_BYTES: String(15 * 1024 * 1024) })).toThrow(
      /FACE_INDEX_MAX_BYTES/,
    );
  });

  it('keeps the encode loop able to land under the limit at every allowed setting', () => {
    // The largest allowed FACE_ENCODE_MIN_LONG_EDGE still fits the default limit.
    expect(faceEncodeFloorBytes(1024)).toBeLessThan(REKOGNITION_INLINE_IMAGE_MAX_BYTES);
    expect(faceEncodeFloorBytes(320)).toBe(460_800);
    expect(() =>
      loadFaceConfig({ FACE_ENCODE_MIN_LONG_EDGE: '1024', FACE_INDEX_LONG_EDGE: '3500' }),
    ).not.toThrow();
    expect(() => loadFaceConfig({ FACE_INDEX_MAX_BYTES: '400000' })).toThrow(
      /FACE_INDEX_MAX_BYTES is too small for FACE_ENCODE_MIN_LONG_EDGE/,
    );
  });
});
