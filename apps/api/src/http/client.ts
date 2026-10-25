import { createHash, createHmac } from 'node:crypto';
import { IP_HASH_VERSION, ipHashInput } from '@shotx/shared';
import type { Request } from 'express';

/**
 * The client address: CloudFront's `CloudFront-Viewer-Address` (`ip:port`, set by CloudFront in
 * front of every `/api/*` request), else the socket address (local runs and tests). Never
 * X-Forwarded-For or another header the client controls.
 */
export function clientIp(req: Request): string {
  const header = req.headers['cloudfront-viewer-address'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined) {
    const match = /^(.+):(\d{1,5})$/.exec(value.trim());
    const ip = (match?.[1] ?? '').replace(/^\[(.*)\]$/, '$1');
    if (ip !== '') return ip;
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
