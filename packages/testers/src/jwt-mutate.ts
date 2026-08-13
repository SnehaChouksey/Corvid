import { createHmac } from 'node:crypto';

// Pure JWT mutations for jwt.mutate_test (D-13). Deterministic and side-effect-free, so each is
// directly unit-testable. They construct a forged token; the tester sends it and the verifier does
// the three-way (none / valid / forged) comparison — the mutations never decide anything.

function b64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function b64urlDecodeToString(segment: string): string {
  return Buffer.from(segment, 'base64url').toString('utf8');
}

interface JwtSegments {
  readonly header: string;
  readonly payload: string;
  readonly signature: string;
}

function splitJwt(jwt: string): JwtSegments {
  const parts = jwt.split('.');
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || header === undefined || payload === undefined || signature === undefined) {
    throw new Error('malformed JWT: expected 3 dot-separated segments');
  }
  return { header, payload, signature };
}

/** Decode the header + payload JSON (for inspection/tests). Throws on a malformed token. */
export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const { header, payload } = splitJwt(jwt);
  return {
    header: JSON.parse(b64urlDecodeToString(header)) as Record<string, unknown>,
    payload: JSON.parse(b64urlDecodeToString(payload)) as Record<string, unknown>,
  };
}

/** `alg:none` downgrade — set the header alg to "none" and drop the signature entirely. */
export function mutateAlgNone(jwt: string): string {
  const { header, payload } = splitJwt(jwt);
  const decodedHeader = JSON.parse(b64urlDecodeToString(header)) as Record<string, unknown>;
  const forgedHeader = b64urlEncode(JSON.stringify({ ...decodedHeader, alg: 'none' }));
  return `${forgedHeader}.${payload}.`;
}

/** HS/RS confusion — re-sign the (unchanged) payload with HS256 using the RS public key as the HMAC secret. */
export function mutateHsRsConfusion(jwt: string, publicKeyPem: string): string {
  const { header, payload } = splitJwt(jwt);
  const decodedHeader = JSON.parse(b64urlDecodeToString(header)) as Record<string, unknown>;
  const forgedHeader = b64urlEncode(JSON.stringify({ ...decodedHeader, alg: 'HS256' }));
  const signature = createHmac('sha256', publicKeyPem).update(`${forgedHeader}.${payload}`).digest('base64url');
  return `${forgedHeader}.${payload}.${signature}`;
}

/** Key reuse — re-sign with a candidate/weak HMAC secret (e.g. a guessed or leaked signing key). */
export function mutateKeyReuse(jwt: string, secret: string): string {
  const { header, payload } = splitJwt(jwt);
  const decodedHeader = JSON.parse(b64urlDecodeToString(header)) as Record<string, unknown>;
  const forgedHeader = b64urlEncode(JSON.stringify({ ...decodedHeader, alg: 'HS256' }));
  const signature = createHmac('sha256', secret).update(`${forgedHeader}.${payload}`).digest('base64url');
  return `${forgedHeader}.${payload}.${signature}`;
}
