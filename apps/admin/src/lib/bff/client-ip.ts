import {
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  bffClientIpSchema,
  isIpAddress,
} from '@shotx/shared';

/**
 * What the admin app adds to every server-side call to the API (the `/bff/*` proxy and the
 * `/auth/*` sign-in steps; ADR 0008 section 1):
 * - BFF_KEY_HEADER: the admin app's own AUTH_ADMIN_BFF_KEY, so the API knows the call comes from
 *   the admin BFF (the web app has a different key, which the admin app never holds);
 * - BFF_CLIENT_IP_HEADER: the end user's address, which the API trusts only with a valid key
 *   (per-IP sign-in rate limits).
 *
 * Browsers can never set these: the admin app builds them from its own config and from the
 * reverse proxy's X-Forwarded-For, never copies an incoming one, and src/proxy.ts strips any copy
 * a client sends (SERVER_CALL_HEADERS).
 */

/** Headers only the admin app may set on calls to the API; removed from every incoming request. */
export const SERVER_CALL_HEADERS = [BFF_KEY_HEADER, BFF_CLIENT_IP_HEADER] as const;

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

/**
 * The end user's address: the last X-Forwarded-For entry, which the reverse proxy (the only thing
 * that can reach the admin app) overwrites with the TCP peer (ADR 0008 sections 1 and 6). Null
 * when absent or invalid.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
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
  /** AUTH_ADMIN_BFF_KEY (secret: never log it). */
  bffKey: string;
  /** The end user's address (normalizeClientIp), or null when unknown. */
  clientIp: string | null;
}

/** The headers of a server-side call to the API for this context. */
export function serverCallHeaders(context: ServerCallContext): Record<string, string> {
  const ip = context.clientIp === null ? null : normalizeClientIp(context.clientIp);
  return {
    [BFF_KEY_HEADER]: context.bffKey,
    ...(ip !== null ? { [BFF_CLIENT_IP_HEADER]: ip } : {}),
  };
}
