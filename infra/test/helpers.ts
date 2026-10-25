import { readFileSync } from 'node:fs';
import { App, type Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CONTEXT_KEY } from '../lib/constants';
import { loadConfig, type PlatformConfig } from '../lib/config';
import { buildPlatform, type Platform } from '../lib/platform';

type Json = Record<string, unknown>;

/** The `context` block of infra/cdk.json (platform config plus CDK feature flags). */
export function cdkJsonContext(): Json {
  const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
    context: Json;
  };
  return cdkJson.context;
}

/** A deep copy of the `shotx` config object from cdk.json, for tests that mutate it. */
export function rawConfig(): Json {
  return structuredClone(cdkJsonContext()[CONTEXT_KEY]) as Json;
}

export interface Synthesized {
  readonly app: App;
  readonly config: PlatformConfig;
  readonly platform: Platform;
  readonly stacks: Stack[];
  readonly templates: Map<Stack, Template>;
  template(stack: Stack): Template;
}

/** Synthesizes the whole platform from cdk.json, optionally editing the config first. */
export function synthPlatform(edit?: (shotx: Json) => void, extraContext: Json = {}): Synthesized {
  const context = structuredClone(cdkJsonContext());
  edit?.(context[CONTEXT_KEY] as Json);
  const app = new App({ context: { ...context, ...extraContext } });
  const config = loadConfig(app);
  const platform = buildPlatform(app, config);
  const stacks = Object.values(platform).filter((s): s is Stack => s !== undefined);
  const templates = new Map(stacks.map((s) => [s, Template.fromStack(s)]));
  return {
    app,
    config,
    platform,
    stacks,
    templates,
    template: (stack) => {
      const t = templates.get(stack);
      if (t === undefined) throw new Error(`No template for ${stack.stackName}`);
      return t;
    },
  };
}

/** All resources of one type across every stack, as [stackName, logicalId, properties]. */
export function resourcesOfType(s: Synthesized, type: string): [string, string, Json][] {
  const out: [string, string, Json][] = [];
  for (const [stack, template] of s.templates) {
    for (const [id, resource] of Object.entries(template.findResources(type))) {
      out.push([stack.stackName, id, (resource.Properties ?? {}) as Json]);
    }
  }
  return out;
}

/** Recursively collects every value of `key` inside a JSON value. */
export function collect(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return (value as unknown[]).flatMap((v) => collect(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Json).flatMap(([k, v]) =>
      k === key ? [v, ...collect(v, key)] : collect(v, key),
    );
  }
  return [];
}
