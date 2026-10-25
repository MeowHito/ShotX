import type { PipeTransform } from '@nestjs/common';
import { type RequestPart, validationFailedDetails } from '@shotx/shared';
import type { z } from 'zod';
import { ApiError } from './api-error';

/** VALIDATION_FAILED for one issue the schemas can't express (e.g. a cursor from another sort). */
export function validationError(path: (string | number)[], message: string): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Request validation failed', {
    issues: [{ path, message }],
  });
}

/** Parses a request part with a shared schema; failures are VALIDATION_FAILED. */
export function parseRequestPart<T extends z.ZodType>(
  schema: T,
  part: RequestPart,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Request validation failed',
      validationFailedDetails(part, result.error),
    );
  }
  return result.data;
}

/** `@Body(new ZodPipe(route.body, 'body'))`, `@Query(...)`, `@Param(...)`. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(
    private readonly schema: T,
    private readonly part: RequestPart,
  ) {}

  transform(value: unknown): z.output<T> {
    return parseRequestPart(this.schema, this.part, value);
  }
}

/**
 * Checks a response against the route's shared schema before it is sent, so the API can't drift
 * from the contract. A mismatch is a server bug: INTERNAL_ERROR (logged by the filter).
 */
export function respond<T extends z.ZodType>(schema: T, value: z.input<T>): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Response does not match its contract: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}
