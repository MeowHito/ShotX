import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Argon2idParams, argon2idParamsAcceptable } from '@shotx/shared';

/**
 * Share passwords are hashed with argon2id (Node's built-in `crypto.argon2`, Node 24.7+) and
 * stored in PHC string format, `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`, so the
 * parameters travel with each hash and can be raised later without breaking old hashes.
 *
 * New hashes use loadSharePasswordHashConfig (SHARE_PASSWORD_ARGON2_*; OWASP's baseline of
 * 19 MiB, 2 passes, 1 lane by default), a 16-byte salt from the CSPRNG and a 32-byte tag.
 * Verification accepts exactly the stored parameters argon2idParamsAcceptable allows (the same
 * bounds the config loader enforces), so every hash any allowed configuration produces verifies,
 * and a corrupt row can't make the API burn memory or CPU.
 */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = {
  memoryKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
};
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

function derive(
  password: string,
  salt: Buffer,
  params: Argon2idParams,
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
        passes: params.timeCost,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A new argon2id hash of `password` in PHC format, with `params` (the configured ones). */
export async function hashPassword(
  password: string,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<string> {
  if (!argon2idParamsAcceptable(params)) throw new RangeError('argon2id parameters out of bounds');
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, params, TAG_BYTES);
  const { memoryKiB: m, timeCost: t, parallelism: p } = params;
  return `$argon2id$v=${VERSION}$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(tag)}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{16,})$/;

/** True when `password` matches `hash` (constant-time compare). A malformed hash never matches. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const match = PHC.exec(hash);
  if (match === null) return false;
  const [, m, t, p, salt, tag] = match;
  const params: Argon2idParams = {
    memoryKiB: Number(m),
    timeCost: Number(t),
    parallelism: Number(p),
  };
  if (!argon2idParamsAcceptable(params)) return false;
  const expected = Buffer.from(tag ?? '', 'base64');
  const actual = await derive(password, Buffer.from(salt ?? '', 'base64'), params, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
