import type { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

/**
 * WAF rule builders. Flat-rate plans don't support custom rule groups, so every rule is written
 * inline in the web ACL. AWS managed rule groups are allowed and count as one rule each.
 */

type Statement = CfnWebACL.StatementProperty;
type Rule = CfnWebACL.RuleProperty;
type TextTransformation = CfnWebACL.TextTransformationProperty;

export const RATE_LIMITED_BODY_KEY = 'rate_limited';
export const PAYLOAD_TOO_LARGE_BODY_KEY = 'payload_too_large';

/** Matches the API error envelope `{ code, message, details }`; the web app maps codes to Thai. */
export const customResponseBodies: Record<string, CfnWebACL.CustomResponseBodyProperty> = {
  [RATE_LIMITED_BODY_KEY]: {
    contentType: 'APPLICATION_JSON',
    content: JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests', details: {} }),
  },
  [PAYLOAD_TOO_LARGE_BODY_KEY]: {
    contentType: 'APPLICATION_JSON',
    content: JSON.stringify({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
      details: {},
    }),
  },
};

const visibility = (metricName: string): CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: true,
});

const blockWith = (responseCode: number, bodyKey: string): CfnWebACL.RuleActionProperty => ({
  block: { customResponse: { responseCode, customResponseBodyKey: bodyKey } },
});
const blockWith429 = blockWith(429, RATE_LIMITED_BODY_KEY);

const AS_IS: TextTransformation[] = [{ priority: 0, type: 'NONE' }];

/**
 * Path normalisation before matching. The API routes case-insensitively and percent-decodes
 * paths, so `/api/s/<t>/FACE-SEARCH` and `/api/s/<t>/face%2Dsearch` reach the same handler as
 * `/api/s/<t>/face-search`. WAF must see them the same way: decode first, then lowercase.
 */
export const NORMALIZED_PATH: TextTransformation[] = [
  { priority: 0, type: 'URL_DECODE' },
  { priority: 1, type: 'LOWERCASE' },
];

function assertLowercase(what: string, value: string): void {
  if (value !== value.toLowerCase()) {
    throw new Error(`${what} ${JSON.stringify(value)} must be lowercase: WAF lowercases the path`);
  }
}

/** Matches a URI path prefix after URL-decoding and lowercasing the path. */
export function uriStartsWith(prefix: string): Statement {
  assertLowercase('Path prefix', prefix);
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: prefix,
      textTransformations: NORMALIZED_PATH,
    },
  };
}

/** Matches the URL-decoded, lowercased URI path against a regular expression. */
export function uriMatches(regex: string): Statement {
  return {
    regexMatchStatement: {
      fieldToMatch: { uriPath: {} },
      regexString: regex,
      textTransformations: NORMALIZED_PATH,
    },
  };
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<prefix><token><suffix>` with an optional trailing slash, e.g. `^/api/s/.+/face-search/?$`.
 * The token part is `.+` rather than `[^/]+` so an encoded slash in it (decoded by URL_DECODE)
 * still matches.
 */
export function tokenPathRegex(prefix: string, suffix: string): string {
  assertLowercase('Path prefix', prefix);
  assertLowercase('Path suffix', suffix);
  const trimmed = suffix.replace(/\/+$/, '');
  return `^${escapeRegex(prefix)}.+${escapeRegex(trimmed)}/?$`;
}

export function methodIs(method: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { method: {} },
      positionalConstraint: 'EXACTLY',
      searchString: method,
      textTransformations: AS_IS,
    },
  };
}

/** Header value starts with `value`, compared case-insensitively. `name` is lowercase. */
export function headerStartsWith(name: string, value: string): Statement {
  assertLowercase('Header value', value);
  return {
    byteMatchStatement: {
      fieldToMatch: { singleHeader: { Name: name } },
      positionalConstraint: 'STARTS_WITH',
      searchString: value,
      textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
    },
  };
}

/**
 * Regex matching a decimal integer (leading zeros allowed) strictly greater than `n`. WAF has no
 * numeric comparison for header values, so a Content-Length limit is written as a regex:
 * either more digits than `n`, or as many digits and larger at the first differing position.
 */
export function decimalGreaterThanRegex(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a non-negative integer: ${n}`);
  const digits = String(n);
  const k = digits.length;
  const alternatives = [`[1-9][0-9]{${k},}`];
  for (let i = 0; i < k; i++) {
    const d = Number(digits[i]);
    if (d === 9) continue;
    const rest = k - 1 - i;
    const higher = d === 8 ? '9' : `[${d + 1}-9]`;
    alternatives.push(`${digits.slice(0, i)}${higher}${rest > 0 ? `[0-9]{${rest}}` : ''}`);
  }
  return `^0*(${alternatives.join('|')})$`;
}

/** The header is a decimal integer greater than `n` (e.g. Content-Length over a limit). */
export function headerIntegerGreaterThan(name: string, n: number): Statement {
  return {
    regexMatchStatement: {
      fieldToMatch: { singleHeader: { Name: name } },
      regexString: decimalGreaterThanRegex(n),
      textTransformations: AS_IS,
    },
  };
}

/** OR over one or more statements (WAF requires at least two inside an orStatement). */
export function anyOf(statements: Statement[]): Statement {
  const [first, ...rest] = statements;
  if (first === undefined) throw new Error('anyOf needs at least one statement');
  return rest.length === 0 ? first : { orStatement: { statements } };
}

export function allOf(statements: Statement[]): Statement {
  const [first, ...rest] = statements;
  if (first === undefined) throw new Error('allOf needs at least one statement');
  return rest.length === 0 ? first : { andStatement: { statements } };
}

export function not(statement: Statement): Statement {
  return { notStatement: { statement } };
}

export interface ManagedRuleGroupOptions {
  /** Rules in the group switched to Count. */
  readonly countOverrides?: readonly string[];
  /** The group only evaluates requests that match this statement. */
  readonly scopeDown?: Statement;
}

export function managedRuleGroup(
  name: string,
  priority: number,
  options: ManagedRuleGroupOptions = {},
): Rule {
  const countOverrides = options.countOverrides ?? [];
  return {
    name: `aws-${name}`,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name,
        ruleActionOverrides: countOverrides.length
          ? countOverrides.map((rule) => ({ name: rule, actionToUse: { count: {} } }))
          : undefined,
        scopeDownStatement: options.scopeDown,
      },
    },
    visibilityConfig: visibility(`aws-${name}`),
  };
}

export interface RateRuleOptions {
  readonly name: string;
  readonly priority: number;
  readonly limit: number;
  readonly evaluationWindowSec: number;
  readonly action: 'block' | 'captcha';
  readonly scopeDown?: Statement;
}

/** Per-IP rate-based rule. Put the block rule before the CAPTCHA rule so it sees every request. */
export function rateRule(o: RateRuleOptions): Rule {
  return {
    name: o.name,
    priority: o.priority,
    action: o.action === 'block' ? blockWith429 : { captcha: {} },
    statement: {
      rateBasedStatement: {
        aggregateKeyType: 'IP',
        limit: o.limit,
        evaluationWindowSec: o.evaluationWindowSec,
        scopeDownStatement: o.scopeDown,
      },
    },
    visibilityConfig: visibility(o.name),
  };
}

/** Blocks matching requests with 413 and the PAYLOAD_TOO_LARGE error body. */
export function payloadTooLargeRule(name: string, priority: number, statement: Statement): Rule {
  return {
    name,
    priority,
    action: blockWith(413, PAYLOAD_TOO_LARGE_BODY_KEY),
    statement,
    visibilityConfig: visibility(name),
  };
}

export function blockRule(name: string, priority: number, statement: Statement): Rule {
  return {
    name,
    priority,
    action: { block: {} },
    statement,
    visibilityConfig: visibility(name),
  };
}

export function blockUnlessIpInSet(name: string, priority: number, ipSetArn: string): Rule {
  return {
    name,
    priority,
    action: { block: {} },
    statement: { notStatement: { statement: { ipSetReferenceStatement: { arn: ipSetArn } } } },
    visibilityConfig: visibility(name),
  };
}

export { visibility as wafVisibility };
