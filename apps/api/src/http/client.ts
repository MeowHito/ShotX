import { createHash, createHmac } from 'node:crypto';
import { IP_HASH_VERSION, ipHashInput } from '@shotx/shared';
import type { Request } from 'express';

function headerValue(req: Request, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * True when the request reached the API through CloudFront: CloudFront adds `X-Amz-Cf-Id` and a
 * `Via: ... (CloudFront)` header to every origin request.
 *
 * Trust model (infra, Phase 3 review): the ALB's security group accepts only the CloudFront
 * origin-facing prefix list and the web/admin task security groups, so no client on the internet
 * can reach the API without passing through CloudFront, and CloudFront replaces any
 * `CloudFront-Viewer-Address` a viewer sends with its own (the `/api/*` origin request policy
 * forwards it). The web/admin tasks call the API without these CloudFront markers (their SSR
 * requests count as their own socket address), so a header they pass along is never trusted.
 * These markers are not a secret: they only separate CloudFront's requests from the in-VPC
 * callers the security group admits.
 */
export function cameThroughCloudFront(req: Request): boolean {
  const cfId = headerValue(req, 'x-amz-cf-id');
  const via = headerValue(req, 'via');
  return (
    cfId !== undefined && cfId.trim() !== '' && via !== undefined && /\bcloudfront\b/i.test(via)
  );
}

/**
 * The client address: CloudFront's `CloudFront-Viewer-Address` (`ip:port`) when the request came
 * through CloudFront (cameThroughCloudFront), else the socket address (local runs, tests, and the
 * web/admin tasks' server-side calls). Never X-Forwarded-For, and never CloudFront-Viewer-Address
 * on a request without CloudFront's markers.
 */
export function clientIp(req: Request): string {
  if (cameThroughCloudFront(req)) {
    const value = headerValue(req, 'cloudfront-viewer-address');
    if (value !== undefined) {
      const match = /^(.+):(\d{1,5})$/.exec(value.trim());
      const ip = (match?.[1] ?? '').replace(/^\[(.*)\]$/, '$1');
      if (ip !== '') return ip;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * `consents.ip_hash`: `v1:` + base64url(HMAC-SHA256(IP_HASH_SECRET, ipHashInput(ip))). Rate-limit
 * keys use it too, so no raw address is ever written to Redis or the database.
 */
export function ipHash(secret: string, ip: string): string {
  const mac = createHmac('sha256', secret).update(ipHashInput(ip)).digest('base64url');
  return `${IP_HASH_VERSION}:${mac}`;
}

/** Lowercase hex SHA-256: how cookie tokens appear in Redis keys. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The headers CloudFront adds to an origin request (tests and local tooling). */
export function cloudFrontOriginHeaders(viewerAddress: string): Record<string, string> {
  return {
    'cloudfront-viewer-address': viewerAddress,
    'x-amz-cf-id': 'TESTcfIdAbCdEf0123456789==',
    via: '2.0 0123456789abcdef.cloudfront.net (CloudFront)',
  };
}
