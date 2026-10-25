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
