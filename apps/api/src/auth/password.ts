import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Share passwords are hashed with argon2id (Node's built-in `crypto.argon2`, Node 24.7+) and
 * stored in PHC string format, `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`, so the
 * parameters travel with each hash and can be raised later without breaking old hashes.
 *
 * Parameters: OWASP's argon2id baseline (19 MiB, 2 passes, 1 lane), a 16-byte salt from the
 * CSPRNG and a 32-byte tag. They are security parameters rather than product tunables; raising
 * them only affects new hashes.
 */
export const ARGON2ID_PARAMS = { memoryKiB: 19_456, passes: 2, parallelism: 1 } as const;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;

/** Bounds accepted when verifying, so a corrupt row can't make the API burn memory or CPU. */
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

function derive(
  password: string,
  salt: Buffer,
  params: { memoryKiB: number; passes: number; parallelism: number },
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password.normalize('NFC'), 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memoryKiB,
        passes: params.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A new argon2id hash of `password` in PHC format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, ARGON2ID_PARAMS, TAG_BYTES);
  const { memoryKiB: m, passes: t, parallelism: p } = ARGON2ID_PARAMS;
  return `$argon2id$v=${VERSION}$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(tag)}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{16,})$/;

/** True when `password` matches `hash` (constant-time compare). A malformed hash never matches. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const match = PHC.exec(hash);
  if (match === null) return false;
  const [, m, t, p, salt, tag] = match;
  const params = { memoryKiB: Number(m), passes: Number(t), parallelism: Number(p) };
  if (
    params.memoryKiB > MAX_MEMORY_KIB ||
    params.passes < 2 ||
    params.passes > MAX_PASSES ||
    params.parallelism < 1 ||
    params.parallelism > MAX_PARALLELISM ||
    params.memoryKiB < 8 * params.parallelism
  ) {
    return false;
  }
  const expected = Buffer.from(tag ?? '', 'base64');
  const actual = await derive(password, Buffer.from(salt ?? '', 'base64'), params, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
