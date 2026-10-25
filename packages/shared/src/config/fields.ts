import { z } from 'zod';

// Field builders shared by the config loaders. Internal: not re-exported from the package.

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

/** An integer in [min, max], read from a string. */
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

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
