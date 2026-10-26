// IPv4/IPv6 parsing for the config loaders. Internal: not re-exported from the package. Pure:
// no node:net, so the package stays importable anywhere.

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

export interface ParsedRange extends ParsedIp {
  prefix: number;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(text: string): bigint | null {
  const match = IPV4.exec(text);
  if (match === null) return null;
  let value = 0n;
  for (const part of match.slice(1)) {
    if (part.length > 1 && part.startsWith('0')) return null; // no octal-looking octets
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (half: string): string[] | null => {
    if (half === '') return [];
    const parts = half.split(':');
    const out: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (part.includes('.')) {
        // An embedded IPv4 address is allowed only as the last part.
        if (i !== parts.length - 1) return null;
        const v4 = parseIpv4(part);
        if (v4 === null) return null;
        out.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null;
        out.push(part);
      }
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return all.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

const IPV4_MAPPED_PREFIX = 0xffffn << 32n;

/**
 * An IPv4 or IPv6 address. IPv4-mapped IPv6 (`::ffff:172.18.0.5`) is returned as IPv4, so it
 * matches IPv4 ranges. A zone id (`fe80::1%eth0`) is ignored when `allowZone` is set.
 */
export function parseIp(text: string, allowZone = false): ParsedIp | null {
  let address = text.trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) {
    if (!allowZone) return null;
    address = address.slice(0, zone);
  }
  const v4 = parseIpv4(address);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIpv6(address);
  if (v6 === null) return null;
  if (v6 >> 32n === IPV4_MAPPED_PREFIX >> 32n) return { version: 4, value: v6 & 0xffffffffn };
  return { version: 6, value: v6 };
}

/** An address (a /32 or /128) or a CIDR range. Host bits below the prefix are ignored. */
export function parseRange(text: string): ParsedRange | null {
  const [address = '', prefixText, ...rest] = text.trim().split('/');
  if (rest.length > 0) return null;
  const ip = parseIp(address);
  if (ip === null) return null;
  // An IPv4-mapped range written in IPv6 (::ffff:10.0.0.0/104) becomes the IPv4 range.
  const mapped = ip.version === 4 && address.includes(':');
  const bits = ip.version === 4 ? 32 : 128;
  let prefix = bits;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText) - (mapped ? 96 : 0);
    if (prefix < 0 || prefix > bits) return null;
  }
  const shift = BigInt(bits - prefix);
  return { ...ip, value: (ip.value >> shift) << shift, prefix };
}

export function formatRange(range: ParsedRange): string {
  if (range.version === 4) {
    const octets = [24n, 16n, 8n, 0n].map((s) => String((range.value >> s) & 0xffn));
    return `${octets.join('.')}/${range.prefix}`;
  }
  const groups = [];
  for (let s = 112n; s >= 0n; s -= 16n) groups.push(((range.value >> s) & 0xffffn).toString(16));
  return `${groups.join(':')}/${range.prefix}`;
}

/** True when `ip` is inside `range` (same IP version). */
export function inRange(ip: ParsedIp, range: ParsedRange): boolean {
  if (range.version !== ip.version) return false;
  const shift = BigInt((ip.version === 4 ? 32 : 128) - range.prefix);
  return ip.value >> shift === range.value >> shift;
}

/** Loopback, RFC 1918, unique-local and link-local ranges. */
const PRIVATE_RANGES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
].map((text) => {
  const range = parseRange(text);
  if (range === null) throw new Error(`bad built-in range ${text}`);
  return range;
});

/**
 * True for a host that can't be reached from the internet by name or address: an IP literal in a
 * loopback or private range, `localhost` / `*.localhost`, or a single-label name such as a compose
 * service (`redis`), which public DNS never resolves.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === '') return false;
  const ip = parseIp(host);
  if (ip !== null) return PRIVATE_RANGES.some((range) => inRange(ip, range));
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}
