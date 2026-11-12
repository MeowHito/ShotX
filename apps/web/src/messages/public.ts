import type { CONSENT_POLICY_VERSIONS } from '@shotx/shared';
import type { Messages } from './th';

/**
 * Every message exists in every SUPPORTED_LOCALES language (Thai default). The messages are split
 * in two parts per language: the public pages (ADR 0011: share page, gates, face search, consent,
 * results, downloads, and the errors a viewer can see; messages/en.ts, zh.ts) and the rest
 * (StudioMessages: home, pricing, login and the studio; messages/en-studio.ts, zh-studio.ts).
 *
 * Every key below is required by the type: a public key added to th.ts fails typecheck until
 * en.ts and zh.ts have it. Of the consent texts only the current version is translated (an older
 * version, shown only if the API still asks for it, stays Thai); the Thai text is the legal
 * reference and the translations say so (consent.translationNote).
 */
export const PUBLIC_NAMESPACES = [
  'metadata',
  'publicNav',
  'common',
  'share',
  'consent',
  'capture',
  'results',
  'faceDeletion',
  'downloads',
  'lightbox',
  'errors',
] as const;
export type PublicNamespace = (typeof PUBLIC_NAMESPACES)[number];

/** Parts of `errors` a viewer can meet (the rest: billing, passwords, covers, stays Thai). */
export const PUBLIC_ERROR_SECTIONS = ['codes', 'details', 'hints', 'client'] as const;

/** The same shape with every message a plain string. */
export type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

/** The newest consent version (the last of CONSENT_POLICY_VERSIONS), the one translated. */
type Current = typeof CONSENT_POLICY_VERSIONS extends readonly [...unknown[], infer Last]
  ? Last & string
  : never;
type Policies = Messages['consent']['policies'];

export type PublicMessages = Widen<Omit<Pick<Messages, PublicNamespace>, 'consent' | 'errors'>> & {
  consent: Widen<Omit<Messages['consent'], 'policies'>> & {
    /** The current version always; earlier translated versions may stay (e.g. 2026-11-11b). */
    policies: {
      [P in keyof Policies]: { [V in Current]: Widen<Policies[P][V]> } & {
        [V in keyof Policies[P]]?: Widen<Policies[P][V]>;
      };
    };
  };
  errors: Widen<Pick<Messages['errors'], (typeof PUBLIC_ERROR_SECTIONS)[number]>>;
};

/**
 * Everything else: home, pricing, login, password, settings and the whole studio, plus the error
 * sections only a photographer meets (billing, password policy, covers, notices).
 */
export type StudioMessages = Widen<Omit<Messages, PublicNamespace>> & {
  errors: Widen<Omit<Messages['errors'], (typeof PUBLIC_ERROR_SECTIONS)[number]>>;
};

/**
 * A complete bundle in another language. Of the consent texts only the translated versions
 * replace the Thai ones; older versions (no longer offered by the API) stay Thai, the legal
 * reference.
 */
export function withTranslation(
  base: Messages,
  pub: PublicMessages,
  studio: StudioMessages,
): Messages {
  const policies = Object.fromEntries(
    Object.entries(base.consent.policies).map(([purpose, versions]) => [
      purpose,
      { ...versions, ...pub.consent.policies[purpose as keyof Policies] },
    ]),
  );
  const merged = {
    ...base,
    ...studio,
    ...pub,
    consent: { ...pub.consent, policies },
    errors: { ...base.errors, ...studio.errors, ...pub.errors },
  };
  // The keys are exactly Messages' (the types above); only the strings differ from the Thai
  // literal types next-intl infers its key checks from.
  return merged as unknown as Messages;
}
