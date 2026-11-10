import { describe, expect, it } from 'vitest';
import { IdempotencyKeys } from './idempotency';

describe('IdempotencyKeys', () => {
  it('keeps the key for a retried identical request and renews it after an answer', () => {
    let n = 0;
    const keys = new IdempotencyKeys(() => `key-${++n}`);
    expect(keys.keyFor('a')).toBe('key-1');
    expect(keys.keyFor('a')).toBe('key-1');
    keys.settle();
    expect(keys.keyFor('a')).toBe('key-2');
  });

  it('starts a new key when the request changes', () => {
    let n = 0;
    const keys = new IdempotencyKeys(() => `key-${++n}`);
    expect(keys.keyFor('a')).toBe('key-1');
    expect(keys.keyFor('b')).toBe('key-2');
    expect(keys.keyFor('a')).toBe('key-3');
  });

  it('uses random UUIDs by default', () => {
    const keys = new IdempotencyKeys();
    expect(keys.keyFor('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
