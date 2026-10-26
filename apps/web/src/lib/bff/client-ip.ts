import {
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  bffClientIpSchema,
  isIpAddress,
} from '@shotx/shared';

/**
 * What web adds to every server-side call to the API (the `/bff/*` proxy, server-side rendering
 * and the `/auth/*` sign-in routes; ADR 0008 section 1):
 * - BFF_KEY_HEADER: the shared AUTH_BFF_KEY, so the API knows the call comes from web;
 * - BFF_CLIENT_IP_HEADER: the end user's address, which the API trusts only with a valid key
 *   (per-IP rate limits, `consents.ip_hash`).
 * Without a key (AUTH_PROVIDER=cognito with AUTH_BFF_KEY unset) neither is sent.
 *
 * Browsers can never set these: web builds them from its own config and from a header only the
 * reverse proxy (or CloudFront) controls, never copies an incoming one, and src/proxy.ts strips
 * any copy a client sends (SERVER_CALL_HEADERS).
 */

/** Headers only web may set on calls to the API; removed from every incoming request. */
export const SERVER_CALL_HEADERS = [BFF_KEY_HEADER, BFF_CLIENT_IP_HEADER] as const;

/**
 * Where web reads the end user's address:
 * - `x-forwarded-for` (AUTH_PROVIDER=shotx or local, the VPS): only the reverse proxy can reach
 *   web, and it overwrites X-Forwarded-For with the TCP peer (ADR 0008 sections 1 and 6). The last
 *   entry is used, which is the proxy's own even if it were misconfigured to append. When the
 *   header is absent, Next.js fills it with the socket peer, so local development without a proxy
 *   sends the browser's loopback address: the true peer, and harmless.
 * - `cloudfront-viewer-address` (AUTH_PROVIDER=cognito, AWS): CloudFront overwrites it (`ip:port`)
 *   and the ALB accepts only CloudFront; X-Forwarded-For there ends with CloudFront's edge address,
 *   not the viewer's.
 */
export type ClientIpSource = 'x-forwarded-for' | 'cloudfront-viewer-address';

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * A plain IPv4 or IPv6 address as BFF_CLIENT_IP_HEADER carries it (bffClientIpSchema), or null.
 * Brackets and an IPv6 zone id are dropped; an IPv4-mapped IPv6 address becomes IPv4.
 */
export function normalizeClientIp(value: string): string | null {
  let address = value.trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (!isIpAddress(address)) return null;
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  address = IPV4_MAPPED.exec(address)?.[1] ?? address;
  return bffClientIpSchema.safeParse(address).success ? address : null;
}

/** The end user's address from the incoming request's headers, or null when absent or invalid. */
export function clientIpFromHeaders(headers: Headers, source: ClientIpSource): string | null {
  if (source === 'cloudfront-viewer-address') {
    const value = headers.get('cloudfront-viewer-address');
    const match = value === null ? null : /^(.+):(\d{1,5})$/.exec(value.trim());
    return match?.[1] === undefined ? null : normalizeClientIp(match[1]);
  }
  const value = headers.get('x-forwarded-for');
  if (value === null) return null;
  const last = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);
  return last === undefined ? null : normalizeClientIp(last);
}

/** Who a server-side API call is made for. */
export interface ServerCallContext {
  /** AUTH_BFF_KEY (secret: never log it). Null: send neither header. */
  bffKey: string | null;
  /** The end user's address (normalizeClientIp), or null when web doesn't know it. */
  clientIp: string | null;
}

/** The headers of a server-side call to the API for this context. */
export function serverCallHeaders(context: ServerCallContext): Record<string, string> {
  if (context.bffKey === null) return {};
  const ip = context.clientIp === null ? null : normalizeClientIp(context.clientIp);
  return {
    [BFF_KEY_HEADER]: context.bffKey,
    ...(ip !== null ? { [BFF_CLIENT_IP_HEADER]: ip } : {}),
  };
}
