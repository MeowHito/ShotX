import type * as NodeCrypto from 'node:crypto';

// Internal: not re-exported from the package. node:crypto is loaded at call time with
// process.getBuiltinModule (Node.js 22.3+), never imported, so browser bundles that import
// @shotx/shared don't pull it in. Only server-side config loaders call this.

function nodeCrypto(): typeof NodeCrypto {
  const mod = globalThis.process?.getBuiltinModule?.('node:crypto');
  if (mod === undefined) throw new Error('This configuration loader needs Node.js (node:crypto)');
  return mod;
}

/** Lowercase hex SHA-256. */
export function sha256Hex(data: Uint8Array | string): string {
  return nodeCrypto().createHash('sha256').update(data).digest('hex');
}

/** DER bytes of a single-block PEM (as normalized by the key fields). */
export function pemDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** SPKI DER of the public half of a PKCS#8 private key PEM. */
export function publicKeyDerOf(privateKeyPem: string): Uint8Array {
  const crypto = nodeCrypto();
  return new Uint8Array(
    crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({
      format: 'der',
      type: 'spki',
    }),
  );
}
