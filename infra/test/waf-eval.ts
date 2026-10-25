/**
 * A small evaluator for the subset of AWS WAF statements the web ACLs use, working on the
 * synthesized CloudFormation JSON. Tests feed it request variants (case, trailing slash,
 * percent-encoding) to check what a rule really matches, instead of only checking strings in the
 * template. Unsupported statements, fields or transformations throw, so a new construct can't
 * silently evaluate to "no match".
 */

type Json = Record<string, unknown>;

export interface WafRequest {
  readonly method: string;
  /** Path as sent on the wire (percent-encoding preserved), without the query string. */
  readonly path: string;
  /** Header names in lowercase. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Client IPv4 address, for IP set statements. */
  readonly ip?: string;
}

/**
 * Addresses of the IP sets a web ACL references, by the logical id in the IP set's
 * `Fn::GetAtt` ARN. Tests register them from the template with {@link registerIpSets}.
 */
const ipSets = new Map<string, readonly string[]>();

export function registerIpSets(resources: Record<string, Json>): void {
  for (const [id, r] of Object.entries(resources)) {
    ipSets.set(id, (r.Properties as Json).Addresses as string[]);
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`not an IPv4 address: ${ip}`);
  }
  return parts.reduce((n, p) => n * 256 + p, 0);
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string];
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

/** WAF URL_DECODE: decodes %XX escapes; malformed escapes stay as they are. */
function urlDecode(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(s[i]));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function transform(value: string, transformations: Json[]): string {
  return [...transformations]
    .sort((a, b) => (a.Priority as number) - (b.Priority as number))
    .reduce((v, t) => {
      switch (t.Type) {
        case 'NONE':
          return v;
        case 'LOWERCASE':
          return v.toLowerCase();
        case 'URL_DECODE':
          return urlDecode(v);
        default:
          throw new Error(`unsupported text transformation ${String(t.Type)}`);
      }
    }, value);
}

/** Header value, or undefined when the request doesn't carry the header. */
function field(fieldToMatch: Json, req: WafRequest): string | undefined {
  if ('UriPath' in fieldToMatch) return req.path;
  if ('Method' in fieldToMatch) return req.method;
  if ('SingleHeader' in fieldToMatch) {
    const name = ((fieldToMatch.SingleHeader as Json).Name as string).toLowerCase();
    return req.headers?.[name];
  }
  throw new Error(`unsupported field ${JSON.stringify(fieldToMatch)}`);
}

export function matches(statement: Json, req: WafRequest): boolean {
  const [kind, body] = Object.entries(statement)[0] as [string, Json];
  switch (kind) {
    case 'AndStatement':
      return (body.Statements as Json[]).every((s) => matches(s, req));
    case 'OrStatement':
      return (body.Statements as Json[]).some((s) => matches(s, req));
    case 'NotStatement':
      return !matches(body.Statement as Json, req);
    case 'ByteMatchStatement': {
      const raw = field(body.FieldToMatch as Json, req);
      if (raw === undefined) return false;
      const value = transform(raw, body.TextTransformations as Json[]);
      const needle = body.SearchString as string;
      switch (body.PositionalConstraint) {
        case 'EXACTLY':
          return value === needle;
        case 'STARTS_WITH':
          return value.startsWith(needle);
        case 'ENDS_WITH':
          return value.endsWith(needle);
        case 'CONTAINS':
          return value.includes(needle);
        default:
          throw new Error(`unsupported positional constraint ${String(body.PositionalConstraint)}`);
      }
    }
    case 'IPSetReferenceStatement': {
      const arn = body.Arn as Json;
      const getAtt = arn['Fn::GetAtt'] as [string, string] | undefined;
      const addresses = getAtt === undefined ? undefined : ipSets.get(getAtt[0]);
      if (addresses === undefined) throw new Error(`unknown IP set ${JSON.stringify(arn)}`);
      if (req.ip === undefined) throw new Error('IP set statement needs a request ip');
      return addresses.some((cidr) => inCidr(req.ip as string, cidr));
    }
    case 'RegexMatchStatement': {
      const raw = field(body.FieldToMatch as Json, req);
      if (raw === undefined) return false;
      return new RegExp(body.RegexString as string).test(
        transform(raw, body.TextTransformations as Json[]),
      );
    }
    default:
      throw new Error(`unsupported statement ${kind}`);
  }
}

/** The scope-down of a rate-based or managed rule group rule; undefined when it has none. */
export function scopeDown(rule: Json): Json | undefined {
  const statement = rule.Statement as Json;
  const inner = (statement.RateBasedStatement ?? statement.ManagedRuleGroupStatement) as
    Json | undefined;
  if (inner === undefined) throw new Error(`${String(rule.Name)} has no scope-down slot`);
  return inner.ScopeDownStatement as Json | undefined;
}

/** Whether a rule looks at the request at all: its scope-down (or statement) matches. */
export function ruleApplies(rule: Json, req: WafRequest): boolean {
  const statement = rule.Statement as Json;
  if (
    statement.RateBasedStatement !== undefined ||
    statement.ManagedRuleGroupStatement !== undefined
  ) {
    const s = scopeDown(rule);
    return s === undefined || matches(s, req);
  }
  return matches(statement, req);
}
