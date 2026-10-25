import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { FILE_STATUSES, SUBSCRIPTION_STATUSES } from '@shotx/shared';
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

/** Sample values for every ICU argument in a message. */
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
  const all = leaves(th);

  it('are all non-empty and format with their arguments', () => {
    const errors: string[] = [];
    const t = createTranslator({
      locale: 'th',
      messages: th,
      onError: (error) => errors.push(error.message),
    });
    for (const [key, text] of all) {
      expect(text.trim(), key).not.toBe('');
      const out = t(key as never, sampleArgs(text) as never);
      expect(out, key).not.toBe(key);
    }
    expect(errors).toEqual([]);
  });

  it('cover every enum the UI shows', () => {
    expect(Object.keys(th.usage.subscriptionStatus).sort()).toEqual(
      [...SUBSCRIPTION_STATUSES].sort(),
    );
    expect(Object.keys(th.drive.fileStatus).sort()).toEqual([...FILE_STATUSES].sort());
    expect(Object.keys(th.usage.blocked).sort()).toEqual([
      'QUOTA_EXCEEDED',
      'SUBSCRIPTION_INACTIVE',
    ]);
  });

  it('every literal t() key in components and pages exists', () => {
    const missing: string[] = [];
    let checked = 0;
    const known = new Set(all.map(([key]) => key));
    const prefixes = new Set(
      all.flatMap(([key]) => key.split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.'))),
    );
    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, 'utf8');
      // `const t = useTranslations('ns')` / `await getTranslations('ns')`
      const namespaces = new Map<string, string>();
      for (const m of code.matchAll(
        /const (\w+) = (?:await )?(?:useTranslations|getTranslations)\((?:'([\w.]+)')?\)/g,
      )) {
        namespaces.set(m[1] ?? '', m[2] ?? '');
      }
      for (const [fn, ns] of namespaces) {
        if (ns !== '' && !prefixes.has(ns))
          missing.push(`${path.relative(SRC, file)}: namespace ${ns}`);
        for (const m of code.matchAll(new RegExp(`\\b${fn}\\('([\\w.]+)'`, 'g'))) {
          const key = ns ? `${ns}.${m[1]}` : (m[1] ?? '');
          checked++;
          if (!known.has(key)) missing.push(`${path.relative(SRC, file)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // The scan must actually find the app's calls.
    expect(checked).toBeGreaterThan(50);
  });

  it('UI code has no hard-coded Thai: copy goes through next-intl', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.includes(`${path.sep}messages${path.sep}`))
      .filter((file) => /[\u0E00-\u0E7F]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
