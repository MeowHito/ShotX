import { z } from 'zod';

// Field builders shared by the config loaders. Internal: not re-exported from the package.

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** An integer in [min, max], read from a string. */
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/**
 * VAT_RATE_BASIS_POINTS (700 = 7%). One definition for every loader that reads it: billing
 * (VAT-inclusive plan prices) and packages (VAT on top of VAT-exclusive prices, ADR 0026).
 */
export const vatRateBasisPoints = () => int(0, 10_000).default(700);

/**
 * A comma-separated list of distinct integers in [min, max], e.g. `14,7,1`. Whitespace around
 * items is ignored.
 */
export const intList = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.split(',').map((item) => item.trim()))
    .pipe(
      z
        .array(
          z
            .string()
            .regex(/^-?\d+$/, { error: 'must be an integer' })
            .transform(Number)
            .pipe(z.number().int().min(min).max(max)),
        )
        .min(1),
    )
    .refine((items) => new Set(items).size === items.length, { error: 'must not repeat values' });

/** Hosts that may use plain http for browser-facing URLs (local development and tests). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

export interface HttpUrlOptions {
  /** Allow a path (normalized without the trailing slash). Otherwise only an origin is allowed. */
  path?: boolean;
  /** `https` only, except on loopback hosts. For URLs a browser or a third party sees. */
  httpsOnly?: boolean;
}

/**
 * An absolute http(s) URL without credentials, query or fragment, returned normalized: the origin
 * (`https://example.com`), plus the path without its trailing slash when `path` is allowed. Error
 * messages never repeat the value.
 */
export const httpUrl = (options: HttpUrlOptions = {}) =>
  z.string().transform((value, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return fail('must be an absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('must be http or https');
    if (options.httpsOnly === true && url.protocol !== 'https:' && !isLoopback(url)) {
      return fail('must be https (http is allowed only for localhost)');
    }
    if (url.username !== '' || url.password !== '') return fail('must not contain credentials');
    if (url.search !== '' || url.hash !== '') return fail('must not have a query or fragment');
    const path = url.pathname.replace(/\/+$/, '');
    if (options.path !== true && path !== '') return fail('must be an origin without a path');
    return `${url.origin}${path}`;
  });

/**
 * A secret (password, private key, API key). Only presence is validated here, and error messages
 * never repeat the value.
 */
export const secret = () => z.string({ error: 'must be a string' }).min(1);

/** APP_STAGE: same format as the infra stage name (infra/lib/config.ts), e.g. `local`, `prod`. */
export const appStage = () =>
  z.string().regex(/^[a-z][a-z0-9-]{1,15}$/, {
    error: 'must be 2-16 characters: a lowercase letter, then lowercase letters, digits or -',
  });

/** An AWS region name, e.g. `ap-southeast-1`. */
export const awsRegion = () =>
  z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, { error: 'must be an AWS region name' });
