import { CONSENT_POLICY_VERSIONS, LATEST_CONSENT_POLICY_VERSION } from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../i18n/config';
import { en } from './en';
import { PUBLIC_ERROR_SECTIONS, PUBLIC_NAMESPACES, type PublicMessages } from './public';
import { th } from './th';
import { zh } from './zh';

/** Every leaf message as [dotted key, text]. */
function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

type Purpose = 'face_search' | 'face_deletion';

/** The consent versions a translation carries (the current one, and maybe earlier ones). */
function translatedVersions(messages: PublicMessages, purpose: Purpose) {
  return Object.keys(
    messages.consent.policies[purpose],
  ) as (keyof typeof th.consent.policies.face_search)[];
}

/** The Thai public messages, shaped like `messages` (the consent versions it translates). */
function thaiPublic(messages: PublicMessages): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ns of PUBLIC_NAMESPACES) out[ns] = th[ns];
  const pick = (purpose: Purpose) =>
    Object.fromEntries(
      translatedVersions(messages, purpose).map((v) => [v, th.consent.policies[purpose][v]]),
    );
  out.consent = {
    ...th.consent,
    policies: { face_search: pick('face_search'), face_deletion: pick('face_deletion') },
  };
  out.errors = Object.fromEntries(PUBLIC_ERROR_SECTIONS.map((k) => [k, th.errors[k]]));
  return out;
}

/** The ICU argument names of a message, sorted. */
function argNames(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1] as string))].sort();
}

const TRANSLATIONS: [string, PublicMessages][] = [
  ['en', en],
  ['zh', zh],
];

describe('public pages in th, en and zh (ADR 0011)', () => {
  const thai = new Map(leaves(thaiPublic(en)));

  it('the translated consent version is the current one', () => {
    expect(CONSENT_POLICY_VERSIONS.at(-1)).toBe(LATEST_CONSENT_POLICY_VERSION);
  });

  it.each(TRANSLATIONS)('%s has every public key, and no other', (_, messages) => {
    for (const purpose of ['face_search', 'face_deletion'] as const) {
      expect(translatedVersions(messages, purpose)).toContain(LATEST_CONSENT_POLICY_VERSION);
    }
    const expected = new Map(leaves(thaiPublic(messages)));
    expect([...new Map(leaves(messages)).keys()].sort()).toEqual([...expected.keys()].sort());
  });

  it.each(TRANSLATIONS)(
    '%s 2026-11-12 points to the photographer, not the deletion page',
    (_, m) => {
      expect(LATEST_CONSENT_POLICY_VERSION).toBe('2026-11-12');
      const text = leaves(m.consent.policies.face_search['2026-11-12'])
        .map(([, t]) => t)
        .join('\n');
      expect(text).not.toMatch(/Delete my face|删除我的人脸”页面/);
      expect(text).toMatch(/photographer or the event organiser|联系摄影师或活动主办方/);
      // Always-on indexing (ADR 0011 decision 1): no "the photographer sets" claim.
      expect(text).not.toMatch(
        /photographer sets|photographer has the system|摄影师设定|摄影师让系统/,
      );
      expect(text).toMatch(/automatically indexes|系统会自动/);
      expect(m.consent.translationNote).not.toBe('');
    },
  );

  it.each(TRANSLATIONS)('%s messages keep the Thai placeholders and format', (locale, messages) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale: locale as 'en' | 'zh',
      messages: MESSAGES[locale as 'en' | 'zh'],
      onError: (e) => errors.push(e.message),
    });
    for (const [key, text] of leaves(messages)) {
      expect(text.trim(), key).not.toBe('');
      expect(argNames(text), key).toEqual(argNames(thai.get(key) ?? ''));
      const args = Object.fromEntries(argNames(text).map((a) => [a, 3]));
      expect(t(key as never, args as never), key).not.toBe(key);
    }
    expect(errors).toEqual([]);
  });

  it.each(TRANSLATIONS)(
    '%s is actually translated (no Thai left but the language names)',
    (_, m) => {
      for (const [key, text] of leaves(m)) {
        if (key === 'publicNav.locales.th') continue;
        expect(text, key).not.toMatch(/[฀-๿]/);
      }
    },
  );

  it('keeps the studio Thai in every language, and the Thai bundle unchanged', () => {
    expect(MESSAGES.th).toBe(th);
    for (const locale of ['en', 'zh'] as const) {
      expect(MESSAGES[locale].studio).toBe(th.studio);
      expect(MESSAGES[locale].errors.passwordPolicy).toBe(th.errors.passwordPolicy);
      // Older consent versions stay Thai (shown only if the API still asks for them).
      expect(MESSAGES[locale].consent.policies.face_search['2026-10-29']).toBe(
        th.consent.policies.face_search['2026-10-29'],
      );
    }
    expect(MESSAGES.en.share.scan).toBe('Find me by face');
    expect(MESSAGES.zh.share.scan).toBe('用人脸找照片');
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
