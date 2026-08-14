import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { ConfigError } from '@corvid/errors';

// Application-level encryption at rest for analyst-supplied target credentials (D-1, `02` §7):
// AES-256-GCM with a key from the environment/secret store — no cloud-KMS dependency in v1 (§9,
// [Assumption] `02` §503). GCM is authenticated: a tampered ciphertext fails to decrypt rather than
// yielding garbage. This package is generic (it knows nothing about credentials); the caller
// serializes its own payload. Secrets pass through here and must NEVER be logged (§5).

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const KEY_LEN = 32; // AES-256
const VERSION = 'v1';

export interface Cipher {
  /** Encrypt UTF-8 plaintext to a self-describing, tamper-evident token. */
  encrypt(plaintext: string): string;
  /** Decrypt a token from {@link Cipher.encrypt}; throws if tampered, truncated, or wrong-key. */
  decrypt(token: string): string;
}

/**
 * Decode a base64 (or base64url) encryption key to a 32-byte buffer. Fails CLOSED (ConfigError,
 * terminal at boot — §9) on a missing/short/long key: we never silently pad or truncate a key.
 * Generate one with `openssl rand -base64 32`.
 */
export function loadKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64'); // base64 decoder also accepts base64url alphabet
  if (key.length !== KEY_LEN) {
    // Do not echo the value or its length-derived detail beyond the coarse fact (§5).
    throw new ConfigError('ENCRYPTION_KEY must decode to 32 bytes (AES-256)');
  }
  return key;
}

export function createCipher(key: Buffer): Cipher {
  if (key.length !== KEY_LEN) {
    throw new ConfigError('encryption key must be 32 bytes (AES-256)');
  }
  // Defensive copy so a caller mutating its buffer can't change our key mid-flight.
  const k = Buffer.from(key);
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGO, k, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ct.toString('base64url'),
      ].join('.');
    },
    decrypt(token) {
      const parts = token.split('.');
      if (parts.length !== 4) {
        throw new Error('malformed ciphertext');
      }
      const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
      // Constant-time version compare — avoids leaking, via timing, how far a forged token parsed.
      const vBuf = Buffer.from(version);
      const expected = Buffer.from(VERSION);
      if (vBuf.length !== expected.length || !timingSafeEqual(vBuf, expected)) {
        throw new Error('unsupported ciphertext version');
      }
      const iv = Buffer.from(ivB64, 'base64url');
      const tag = Buffer.from(tagB64, 'base64url');
      const ct = Buffer.from(ctB64, 'base64url');
      const decipher = createDecipheriv(ALGO, k, iv);
      decipher.setAuthTag(tag);
      // .final() throws if the GCM tag doesn't authenticate — a tampered or wrong-key token.
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    },
  };
}
