import type { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

/**
 * WAF rule builders. Flat-rate plans don't support custom rule groups, so every rule is written
 * inline in the web ACL. AWS managed rule groups are allowed and count as one rule each.
 */

type Statement = CfnWebACL.StatementProperty;
type Rule = CfnWebACL.RuleProperty;

export const RATE_LIMITED_BODY_KEY = 'rate_limited';

/** Matches the API error envelope `{ code, message, details }`; the web app maps codes to Thai. */
export const rateLimitedResponseBodies: Record<string, CfnWebACL.CustomResponseBodyProperty> = {
  [RATE_LIMITED_BODY_KEY]: {
    contentType: 'APPLICATION_JSON',
    content: JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests', details: {} }),
  },
};

const visibility = (metricName: string): CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: true,
});

const blockWith429: CfnWebACL.RuleActionProperty = {
  block: { customResponse: { responseCode: 429, customResponseBodyKey: RATE_LIMITED_BODY_KEY } },
};

export function uriStartsWith(prefix: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: prefix,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

export function uriEndsWith(suffix: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'ENDS_WITH',
      searchString: suffix,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

export function methodIs(method: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { method: {} },
      positionalConstraint: 'EXACTLY',
      searchString: method,
      textTransformations: [{ priority: 0, type: 'NONE' }],
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

export function managedRuleGroup(
  name: string,
  priority: number,
  countOverrides: readonly string[] = [],
): Rule {
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
