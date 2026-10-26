import { sha256Hex } from './node-crypto';

// Internal: not re-exported from the package.
//
// SHA-256 fingerprints of the placeholder secrets published in .env.example (ADR 0008 review M2).
// They are public, so they are refused anywhere but APP_STAGE=local. Only fingerprints live here,
// never the values. Keys are fingerprinted as DER bytes (so their PEM and base64 forms match), the
// TOTP key as its 32 decoded bytes and the BFF key as its UTF-8 text. When .env.example's
// placeholders change, add the new fingerprints (keep the old ones).

/** Fingerprints of published Ed25519 keys: PKCS#8 private keys and their SPKI public halves. */
export const EXAMPLE_SIGNING_KEY_FINGERPRINTS: ReadonlySet<string> = new Set([
  // AUTH_USERS_SIGNING_KEY (private, public)
  '46e660e4f004a714fec40490caee30e2c07b98fe45b43e00a048c4bac9c4a3e5',
  'f9aac28b31465f5aada4b6fa97cc6b6275c0761882895ff98e7adcef17891fb2',
  // AUTH_ADMINS_SIGNING_KEY (private, public)
  '2e58740b723a229127c656fecbaf4d8284b4bdce5d57664b189dc15494c02333',
  '16fde897313880c339e1defcb438dca689446d3146e93a91ab772787ebba6d29',
]);

/** ADMIN_TOTP_ENCRYPTION_KEY. */
export const EXAMPLE_TOTP_KEY_FINGERPRINTS: ReadonlySet<string> = new Set([
  '94e90d2011f596529abec16a5497028c09be589868a82baa3b16a16771b2c3d7',
]);

/** AUTH_BFF_KEY. */
export const EXAMPLE_BFF_KEY_FINGERPRINTS: ReadonlySet<string> = new Set([
  '3b97c99a6e427e9c0208cc7b649eb82880ba0815d3485325938d88a5c2dd4c47',
]);

export function isPublishedExample(fingerprints: ReadonlySet<string>, data: Uint8Array | string) {
  return fingerprints.has(sha256Hex(data));
}
