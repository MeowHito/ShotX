import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { AUTH_PROVIDER_NAMES } from './auth';
import { formatRange, inRange, parseIp, parseRange } from './ip';
import { isLocalStage } from './stage-gate';

// Which socket peers may set X-Forwarded-For (ADR 0008 section 1, "Client IP").

/** True for an IPv4 or IPv6 address (brackets and a zone id allowed). */
export function isIpAddress(value: string): boolean {
  return parseIp(value, true) !== null;
}

/** Explicit "trust no proxy" value of TRUSTED_PROXY_ADDRESSES. */
export const TRUSTED_PROXY_NONE = 'none';

const addressList = z.string().transform((value, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  if (value.trim().toLowerCase() === TRUSTED_PROXY_NONE) return [];
  const addresses: string[] = [];
  if (value.split(',').every((item) => item.trim() === '')) {
    return fail(`must list at least one address, or ${TRUSTED_PROXY_NONE}`);
  }
  for (const item of value.split(',')) {
    if (item.trim() === '') continue;
    const range = parseRange(item);
    if (range === null) {
      return fail(`must be comma-separated IPv4/IPv6 addresses, or ${TRUSTED_PROXY_NONE}`);
    }
    // Single hosts only. The api ignores the BFF key and client-IP headers from a trusted proxy
    // (that is internet traffic), so a range such as the compose network's would also cover the
    // web and admin containers and break every BFF call; 0.0.0.0/0 would trust everyone.
    if (range.prefix !== (range.version === 4 ? 32 : 128)) {
      return fail(
        "must list single addresses (the reverse proxy's own), not ranges such as a network",
      );
    }
    addresses.push(formatRange(range));
  }
  return [...new Set(addresses)];
});

const trustedProxyEnvSchema = z.object({
  AUTH_PROVIDER: z.enum(AUTH_PROVIDER_NAMES).default('cognito'),
  /** Blank or whitespace only counts as unset (parseEnv already drops ''), never as `none`. */
  TRUSTED_PROXY_ADDRESSES: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    addressList.optional(),
  ),
});

export interface TrustedProxyConfig {
  /**
   * The trusted proxy addresses as single-host CIDR (`172.18.0.2/32`, `0:0:0:0:0:0:0:1/128`).
   * Empty: trust no peer, so X-Forwarded-For is never read.
   */
  addresses: readonly string[];
}

/**
 * Reads TRUSTED_PROXY_ADDRESSES (api): the reverse proxy's own IPv4/IPv6 address(es), whose
 * X-Forwarded-For the API trusts (the proxy overwrites it with the TCP peer), or `none`.
 *
 * Only single addresses are accepted (`/32` and `/128` written out are fine), never ranges: the
 * api treats a trusted proxy's requests as internet traffic and ignores the BFF key and
 * BFF_CLIENT_IP_HEADER on them, so a range such as the compose network (172.18.0.0/16) would make
 * the web and admin containers count as the proxy and every `/auth/*` call would be refused. On
 * the VPS give the proxy container a fixed address on the compose network (compose
 * `ipv4_address`) and list that one address here.
 *
 * Unset (also blank or whitespace only) means none, except that AUTH_PROVIDER=shotx outside
 * APP_STAGE=local requires it (`none` written out, only if the API really has no proxy in front),
 * so a forgotten or blanked setting can't collapse every client to the proxy's IP. A value of only
 * commas is an error.
 */
export function loadTrustedProxyConfig(env: Env): TrustedProxyConfig {
  const e = parseEnv(trustedProxyEnvSchema, env, 'trusted proxy');
  if (
    e.TRUSTED_PROXY_ADDRESSES === undefined &&
    e.AUTH_PROVIDER === 'shotx' &&
    !isLocalStage(env, 'trusted proxy')
  ) {
    throw new Error(
      `Invalid trusted proxy configuration: TRUSTED_PROXY_ADDRESSES is required with AUTH_PROVIDER=shotx outside APP_STAGE=local (the proxy's own address, or ${TRUSTED_PROXY_NONE})`,
    );
  }
  return { addresses: e.TRUSTED_PROXY_ADDRESSES ?? [] };
}

/**
 * True when the socket peer `address` is one of the trusted proxy addresses. IPv4-mapped IPv6 peers
 * (`::ffff:172.18.0.5`, as Node reports IPv4 on a dual-stack socket) match IPv4 addresses. An
 * unparsable address is never trusted.
 */
export function isTrustedProxy(address: string, config: TrustedProxyConfig): boolean {
  const ip = parseIp(address, true);
  if (ip === null) return false;
  return config.addresses.some((text) => {
    const range = parseRange(text);
    return range !== null && inRange(ip, range);
  });
}
