import { CONSENT_POLICY_VERSIONS, LATEST_CONSENT_POLICY_VERSION } from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../i18n/config';
import { en } from './en';
import { enStudio } from './en-studio';
import type { PublicMessages, StudioMessages } from './public';
import { th } from './th';
import { zh } from './zh';
import { zhStudio } from './zh-studio';

/** Every leaf message as [dotted key, text]. */
function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

type Purpose = 'face_search' | 'face_deletion';

/** A language's own messages: the public part and the rest (messages/public). */
function source(pub: PublicMessages, studio: StudioMessages) {
  return { ...studio, ...pub, errors: { ...studio.errors, ...pub.errors } };
}

/** The consent versions a translation carries (the current one, and maybe earlier ones). */
function translatedVersions(messages: PublicMessages, purpose: Purpose) {
  return Object.keys(
    messages.consent.policies[purpose],
  ) as (keyof typeof th.consent.policies.face_search)[];
}

/**
 * The Thai keys a translation must have: the whole tree, except consent texts older than the
 * versions it translates (no longer offered by the API; the Thai legal text stays).
 */
function expectedKeys(messages: PublicMessages): string[] {
  return leaves(th)
    .map(([key]) => key)
    .filter((key) => {
      const m = /^consent\.policies\.(\w+)\.([\w-]+)\./.exec(key);
      return m === null || translatedVersions(messages, m[1] as Purpose).includes(m[2] as never);
    })
    .sort();
}

/** The ICU argument names of a message, sorted. */
function argNames(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1] as string))].sort();
}

const TRANSLATIONS: [string, PublicMessages, StudioMessages][] = [
  ['en', en, enStudio],
  ['zh', zh, zhStudio],
];

describe('every page in th, en and zh (ADR 0011)', () => {
  const thai = new Map(leaves(th));

  it('the translated consent version is the current one', () => {
    expect(CONSENT_POLICY_VERSIONS.at(-1)).toBe(LATEST_CONSENT_POLICY_VERSION);
  });

  it.each(TRANSLATIONS)('%s has every key of the whole tree, and no other', (_, pub, studio) => {
    for (const purpose of ['face_search', 'face_deletion'] as const) {
      expect(translatedVersions(pub, purpose)).toContain(LATEST_CONSENT_POLICY_VERSION);
    }
    const keys = leaves(source(pub, studio)).map(([key]) => key);
    expect(keys.sort()).toEqual(expectedKeys(pub));
  });

  it.each(TRANSLATIONS)('%s keeps the Thai placeholders and formats', (locale, pub, studio) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale: locale as 'en' | 'zh',
      messages: MESSAGES[locale as 'en' | 'zh'],
      onError: (e) => errors.push(e.message),
    });
    for (const [key, text] of leaves(source(pub, studio))) {
      expect(text.trim(), key).not.toBe('');
      expect(argNames(text), key).toEqual(argNames(thai.get(key) ?? ''));
      const args = Object.fromEntries(argNames(text).map((a) => [a, 3]));
      expect(t(key as never, args as never), key).not.toBe(key);
    }
    expect(errors).toEqual([]);
  });

  it.each(TRANSLATIONS)('%s has no Thai left but the language names', (_, pub, studio) => {
    for (const [key, text] of leaves(source(pub, studio))) {
      if (key === 'publicNav.locales.th') continue;
      expect(text, key).not.toMatch(/[\u0E00-\u0E7F]/);
    }
  });

  it('the bundles are complete: only the older consent texts are the Thai ones', () => {
    expect(MESSAGES.th).toBe(th);
    for (const locale of ['en', 'zh'] as const) {
      expect(MESSAGES[locale].studio.drive).not.toBe(th.studio.drive);
      expect(MESSAGES[locale].errors.passwordPolicy.too_short).not.toBe(
        th.errors.passwordPolicy.too_short,
      );
      expect(MESSAGES[locale].consent.policies.face_search['2026-10-29']).toBe(
        th.consent.policies.face_search['2026-10-29'],
      );
    }
    expect(MESSAGES.en.studio.drive).toBe('My Drive');
    expect(MESSAGES.zh.studio.drive).toBe('我的云盘');
    expect(MESSAGES.en.shares.copyDeletionLink).toBe('Copy face deletion link');
  });

  it.each(TRANSLATIONS)('%s 2026-11-12: ask the photographer; indexing is automatic', (_, m) => {
    expect(LATEST_CONSENT_POLICY_VERSION).toBe('2026-11-12');
    const text = leaves(m.consent.policies.face_search['2026-11-12'])
      .map(([, t]) => t)
      .join('\n');
    expect(text).not.toMatch(/Delete my face|删除我的人脸”页面/);
    expect(text).toMatch(/photographer or the event organiser|联系摄影师或活动主办方/);
    expect(text).not.toMatch(
      /photographer sets|photographer has the system|摄影师设定|摄影师让系统/,
    );
    expect(text).toMatch(/automatically indexes|系统会自动/);
  });

  it('the translated consent texts keep the legal points and say they are translations', () => {
    for (const [, m] of TRANSLATIONS) {
      const search = (m.consent.policies.face_search as Record<string, unknown>)[
        LATEST_CONSENT_POLICY_VERSION
      ];
      const all = leaves(search)
        .map(([, text]) => text)
        .join('\n');
      expect(all).toMatch(/26/);
      expect(all).toMatch(/28/);
      expect(all).not.toContain('Amazon');
      expect(m.consent.translationNote).not.toBe('');
    }
    expect(en.consent.translationNote).toContain('Thai text is the legal reference');
    expect(zh.consent.translationNote).toContain('泰文');
  });
});
