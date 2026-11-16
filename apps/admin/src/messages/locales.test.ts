import { SUPPORTED_LOCALES } from '@shotx/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { HTML_LANG, INTL_LOCALE, intlLocale, LOCALES, MESSAGES } from '../i18n/config';
import { en } from './en';
import { th } from './th';
import type { TranslatedMessages } from './translation';
import { zh } from './zh';

/** Every leaf message as [dotted key, text]. */
function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Every key segment of a tree (next-intl splits on '.', so no segment may contain one). */
function segments(value: unknown): string[] {
  if (typeof value === 'string') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...segments(child),
  ]);
}

/** The ICU argument names of a message, sorted. */
function argNames(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1] as string))].sort();
}

/**
 * What each ICU argument takes, sorted (`minutes:number`, `email:text`): a plain `{x}` is text,
 * number / plural / selectordinal need a number, date / time a date. A translation may say a
 * number another way (English pluralises `{minutes, number}`), but never change what it takes.
 */
function argKinds(message: string): string[] {
  const kind = (type: string | undefined) =>
    type === undefined || type === 'select'
      ? 'text'
      : ['number', 'plural', 'selectordinal'].includes(type)
        ? 'number'
        : ['date', 'time'].includes(type)
          ? 'date'
          : type;
  return [
    ...new Set(
      [...message.matchAll(/\{(\w+)\s*(?:,\s*(\w+))?\s*[,}]/g)].map(
        (m) => `${m[1] as string}:${kind(m[2])}`,
      ),
    ),
  ].sort();
}

const TRANSLATIONS: ['en' | 'zh', TranslatedMessages][] = [
  ['en', en],
  ['zh', zh],
];

describe('admin UI in th, en and zh', () => {
  const thai = new Map(leaves(th));

  it('offers the shared locales, Thai first and default', () => {
    expect(LOCALES).toEqual(SUPPORTED_LOCALES);
    expect(LOCALES).toEqual(['th', 'en', 'zh']);
    expect(HTML_LANG).toEqual({ th: 'th', en: 'en', zh: 'zh-Hans' });
    expect(INTL_LOCALE).toEqual({ th: 'th-TH', en: 'en-GB', zh: 'zh-CN' });
    expect(intlLocale('fr')).toBe('th-TH');
  });

  it('keys never contain a dot', () => {
    for (const tree of [th, en, zh]) {
      for (const key of segments(tree)) expect(key, key).not.toContain('.');
    }
  });

  it.each(TRANSLATIONS)('%s has exactly the Thai keys', (_, messages) => {
    expect(
      leaves(messages)
        .map(([key]) => key)
        .sort(),
    ).toEqual([...thai.keys()].sort());
  });

  it.each(TRANSLATIONS)('%s keeps the Thai ICU arguments and formats', (locale, messages) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: MESSAGES[locale],
      onError: (e) => errors.push(e.message),
    });
    for (const [key, text] of leaves(messages)) {
      expect(text.trim(), key).not.toBe('');
      expect(argNames(text), key).toEqual(argNames(thai.get(key) ?? ''));
      expect(argKinds(text), key).toEqual(argKinds(thai.get(key) ?? ''));
      const args = Object.fromEntries(argNames(text).map((a) => [a, 3]));
      expect(t(key as never, args as never), key).not.toBe(key);
    }
    expect(errors).toEqual([]);
  });

  it.each(TRANSLATIONS)('%s has no Thai left but the language name', (_, messages) => {
    for (const [key, text] of leaves(messages)) {
      if (key === 'language.locales.th') continue;
      expect(text, key).not.toMatch(/[฀-๿]/);
    }
  });

  it.each(TRANSLATIONS)('%s never offers plans or checkout (BILLING_MODE=offline)', (_, m) => {
    // The error codes of the switched-off billing API keep their messages (an exhaustive map).
    // ADR 0026: the users page shows a photographer's package (套餐), but never sells one.
    const ui = Object.entries(m)
      .filter(([namespace]) => namespace !== 'errors')
      .flatMap(([, tree]) => leaves(tree))
      .map(([, text]) => text)
      .join('\n');
    expect(ui).not.toMatch(
      /checkout|online payment|在线支付|结账|购买套餐|升级套餐|buy a package/i,
    );
  });

  it('uses the agreed admin terms', () => {
    expect(MESSAGES.th).toBe(th);
    expect(MESSAGES.en.roles.photographer).toBe('Photographer');
    expect(MESSAGES.zh.roles.photographer).toBe('摄影师');
    expect(MESSAGES.en.cash.title).toBe('Cash payments');
    expect(MESSAGES.zh.cash.title).toBe('现金付款');
    for (const locale of LOCALES) {
      expect(MESSAGES[locale].language.locales).toEqual({ th: 'ไทย', en: 'English', zh: '中文' });
    }
  });

  it('compares what each argument takes, not only its name', () => {
    expect(argKinds('{minutes, number} min')).toEqual(['minutes:number']);
    expect(argKinds('{minutes, plural, one {# minute} other {# minutes}}')).toEqual([
      'minutes:number',
    ]);
    expect(argKinds('{email} at {time}')).toEqual(['email:text', 'time:text']);
    expect(argKinds('{max}')).not.toEqual(argKinds('{max, number}'));
  });

  it('pluralises the English wait time', () => {
    const t = createTranslator({ locale: 'en', messages: MESSAGES.en, namespace: 'errors' });
    expect(t('rateLimitedWait', { minutes: 1 })).toContain('1 minute and');
    expect(t('rateLimitedWait', { minutes: 5 })).toContain('5 minutes');
  });
});
