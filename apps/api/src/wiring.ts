import { CognitoTokenVerifier, remoteJwks } from './auth/cognito-verifier';
import { LocalTokenVerifier } from './auth/local-verifier';
import type { ApiConfig } from './config';
import { CloudFrontMediaUrlSigner } from './infra/cloudfront-signer';
import { S3PresignMediaUrlSigner } from './infra/s3-presign-signer';
import type { MediaUrlSigner, TokenVerifier } from './tokens';

// Adapter selection for main.ts, from the loaded config (the loaders refuse local options outside
// APP_STAGE=local).

/** Cognito JWTs (remote JWKS) on deployed stages; HS256 local tokens with AUTH_PROVIDER=local. */
export function tokenVerifier(config: ApiConfig): TokenVerifier {
  if (config.auth.provider === 'local') return new LocalTokenVerifier(config.auth.secret);
  if (config.cognito === null) throw new Error('Cognito configuration is missing');
  return new CognitoTokenVerifier(config.cognito, remoteJwks(config.cognito));
}

/** CloudFront signed URLs on deployed stages; S3 presigned URLs with MEDIA_URL_SIGNER=s3-presign. */
export function mediaUrlSigner(config: ApiConfig): MediaUrlSigner {
  if (config.mediaUrls.signer === 's3-presign') {
    if (config.aws.endpointUrl === null) {
      throw new Error('MEDIA_URL_SIGNER=s3-presign needs AWS_ENDPOINT_URL (LocalStack)');
    }
    return new S3PresignMediaUrlSigner({
      endpointUrl: config.aws.endpointUrl,
      region: config.aws.region,
      bucket: config.storage.bucket,
      accessKeyId: config.mediaUrls.accessKeyId,
      secretAccessKey: config.mediaUrls.secretAccessKey,
    });
  }
  if (config.cloudFront === null) throw new Error('CloudFront signing configuration is missing');
  return new CloudFrontMediaUrlSigner(config.cloudFront);
}
