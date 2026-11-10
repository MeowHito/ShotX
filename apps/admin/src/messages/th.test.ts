import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { th } from './th';

/** Every leaf message as [dotted key, text]. */
function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function sampleArgs(message: string): Record<string, string | number> {
  const args: Record<string, string | number> = {};
  for (const match of message.matchAll(/\{(\w+)(?:,\s*(\w+))?/g)) {
    const [, name, type] = match;
    if (name !== undefined) args[name] = type === 'number' ? 3 : 'x';
  }
  return args;
}

const SRC = path.join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('Thai messages', () => {
  it('are all non-empty and format with their arguments', () => {
    const t = createTranslator({ locale: 'th', messages: th });
    for (const [key, message] of leaves(th)) {
      expect(message.trim(), key).not.toBe('');
      expect(() => t(key as never, sampleArgs(message) as never), key).not.toThrow();
    }
  });
});

describe('admin sources', () => {
  it('never offer plans or checkout (BILLING_MODE=offline)', () => {
    const all = leaves(th)
      .map(([, m]) => m)
      .join('\n');
    expect(all).not.toMatch(/แพ็กเกจ(?:ราย|และการชำระ)|ชำระเงินออนไลน์|checkout/i);
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/BILLING_ROUTES|\/billing\/checkout|PLAN_ROUTES/);
    }
  });

  it('never write a password, token or code to the console', () => {
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
  });

  it('never use browser storage', () => {
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
