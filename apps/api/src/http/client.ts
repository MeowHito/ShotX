import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  type AuthPool,
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  bffClientIpSchema,
  IP_HASH_VERSION,
  ipHashInput,
  isIpAddress,
  isTrustedProxy,
  type TrustedProxyConfig,
} from '@shotx/shared';
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

/** Which callers may tell the API the client address (ApiConfig `bffKeys` and `trustedProxies`). */
export interface ClientIpTrust {
  /**
   * The BFF keys by the pool whose app holds each: `users` AUTH_BFF_KEY (web), `admins`
   * AUTH_ADMIN_BFF_KEY (admin app). Null when unset; with neither, BFF_CLIENT_IP_HEADER is never
   * trusted.
   */
  bffKeys: { users: string | null; admins: string | null };
  /** TRUSTED_PROXY_ADDRESSES: socket peers whose X-Forwarded-For is trusted. */
  proxies: TrustedProxyConfig;
}

/** Trust nobody: CloudFront markers and the socket peer only. */
export const NO_CLIENT_IP_TRUST: ClientIpTrust = {
  bffKeys: { users: null, admins: null },
  proxies: { addresses: [] },
};

/**
 * Constant-time comparison of a presented secret with the expected one. Both sides are hashed
 * first, so neither the length nor a common prefix leaks through timing.
 */
export function secretMatches(presented: string | undefined, expected: string | null): boolean {
  if (presented === undefined || expected === null || presented === '') return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * True when the socket peer is the public reverse proxy (TRUSTED_PROXY_ADDRESSES): the request
 * came from the internet, not from the web or admin container.
 */
export function cameThroughPublicProxy(req: Request, proxies: TrustedProxyConfig): boolean {
  const peer = req.socket.remoteAddress;
  return peer !== undefined && isTrustedProxy(peer, proxies);
}

/**
 * The pool of the BFF key the request carries: `users` for web's key, `admins` for the admin
 * app's, null for none or a wrong one. Both keys are always compared, each in constant time, so
 * timing tells nothing about which (if any) matched. BFF headers on a request that came through
 * the public proxy are ignored: web and admin call the API directly on the private network, so
 * such a request is internet traffic (and a leaked key can't be used from outside).
 */
export function hasValidBffKey(req: Request, trust: ClientIpTrust): AuthPool | null {
  if (cameThroughPublicProxy(req, trust.proxies)) return null;
  const presented = headerValue(req, BFF_KEY_HEADER);
  const users = secretMatches(presented, trust.bffKeys.users);
  const admins = secretMatches(presented, trust.bffKeys.admins);
  if (users) return 'users';
  if (admins) return 'admins';
  return null;
}

/** `::ffff:1.2.3.4` as `1.2.3.4`, brackets and zone ids removed; other values unchanged. */
function normalizeIp(value: string): string {
  const trimmed = value.trim().replace(/^\[(.*)\]$/, '$1');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

/**
 * The client address (ADR 0008 section 1), first match wins:
 *
 * 1. BFF_CLIENT_IP_HEADER (`x-shotx-client-ip`) when the request also carries the valid BFF key
 *    and did not come through the public proxy (hasValidBffKey; web and admin pass the viewer's
 *    address on; any route). Otherwise the header is ignored. A value that isn't an IP address
 *    is ignored too.
 * 2. CloudFront's `CloudFront-Viewer-Address` (`ip:port`) when the request came through
 *    CloudFront (cameThroughCloudFront), on AWS stages only: when TRUSTED_PROXY_ADDRESSES is set
 *    the API runs behind its own reverse proxy, which passes client headers through, so the
 *    CloudFront markers prove nothing there and are ignored. Kept until infra/ is removed.
 * 3. X-Forwarded-For when the socket peer is a trusted proxy (isTrustedProxy). The proxy
 *    overwrites the header with the TCP peer, so it holds one value; if a client's copy got
 *    through anyway, only the rightmost entry (the one the proxy wrote) counts.
 * 4. The socket peer.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`, as Node reports IPv4 peers on a dual-stack
 * socket) come back as IPv4.
 */
export function clientIp(req: Request, trust: ClientIpTrust = NO_CLIENT_IP_TRUST): string {
  const forwarded = headerValue(req, BFF_CLIENT_IP_HEADER);
  if (forwarded !== undefined && hasValidBffKey(req, trust) !== null) {
    const parsed = bffClientIpSchema.safeParse(normalizeIp(forwarded));
    if (parsed.success) return parsed.data;
  }
  if (trust.proxies.addresses.length === 0 && cameThroughCloudFront(req)) {
    const value = headerValue(req, 'cloudfront-viewer-address');
    if (value !== undefined) {
      const match = /^(.+):(\d{1,5})$/.exec(value.trim());
      const ip = (match?.[1] ?? '').replace(/^\[(.*)\]$/, '$1');
      if (ip !== '') return normalizeIp(ip);
    }
  }
  const peer = req.socket.remoteAddress;
  if (peer !== undefined && isTrustedProxy(peer, trust.proxies)) {
    const xff = headerValue(req, 'x-forwarded-for');
    const rightmost = xff?.split(',').at(-1)?.trim();
    if (rightmost !== undefined && rightmost !== '' && isIpAddress(rightmost)) {
      return normalizeIp(rightmost);
    }
  }
  return peer === undefined ? 'unknown' : normalizeIp(peer);
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
