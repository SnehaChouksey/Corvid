import { randomBytes } from 'node:crypto';

import { AuthorizationError } from '@corvid/errors';
import { isDangerousHost } from '@corvid/scope';
import * as z from 'zod';

// Proof-of-control (D-7, ADR-D7): before a target can be authorized, the user must prove they
// control it — not a self-asserted checkbox. Corvid mints an unguessable token; the user places it
// in a DNS TXT record OR a /.well-known/ file on the target; Corvid fetches and verifies it. This is
// the anti-abuse control that stops an authenticated user aiming Corvid at a target they don't own.
//
// Pure logic + injected IO ports (DNS + HTTP), so verification is unit-testable offline; the
// composition root (the gateway) wires node:dns/promises and fetch. Everything fails CLOSED: a
// lookup error, an unresolved host, or a non-matching value is "not proven", never "proven".

/** The DNS TXT record lives at this subdomain of the target host. */
export function dnsChallengeName(host: string): string {
  return `_corvid-challenge.${host}`;
}

/** The well-known file Corvid fetches over HTTPS. */
export const WELL_KNOWN_PATH = '/.well-known/corvid-challenge.txt';

export type ProofMethod = 'dns' | 'well_known';

export interface ChallengeInstructions {
  readonly host: string;
  readonly token: string;
  readonly dns: { readonly recordType: 'TXT'; readonly name: string; readonly value: string };
  readonly wellKnown: { readonly url: string; readonly expectedContent: string };
}

/**
 * Mint a challenge token: 32 bytes of CSPRNG entropy, URL-safe. Unguessable by construction, so
 * possession of it in the target's DNS/well-known is what proves control. A fresh token is minted
 * whenever authorization is (re-)requested; a scope edit clears the stored proof (see the target
 * repo), so an old placed record no longer matches — re-proving is required after widening scope.
 */
export function mintChallengeToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The host whose control is being proven — the target URL's hostname. Fails closed (loud) on a URL
 * that doesn't parse or has no host: proof-of-control against "nothing" is an authorization refusal.
 */
export function hostForTarget(targetUrl: string): string {
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    throw new AuthorizationError('Target URL is not a valid URL');
  }
  if (host.length === 0) {
    throw new AuthorizationError('Target URL has no host');
  }
  return host;
}

export function challengeInstructions(host: string, token: string): ChallengeInstructions {
  return {
    host,
    token,
    dns: { recordType: 'TXT', name: dnsChallengeName(host), value: token },
    wellKnown: { url: `https://${host}${WELL_KNOWN_PATH}`, expectedContent: token },
  };
}

// ── Stored proof shape (targets.proof_of_control jsonb) ──────────────────────────────────────────

// Only the pending proof is ever PARSED (from stored jsonb, at the trust boundary — see
// readPendingToken); the verified proof is only ever CONSTRUCTED by us, so it's a plain type.
const pendingProofSchema = z
  .object({ status: z.literal('pending'), token: z.string().min(1), issuedAt: z.string() })
  .strict();

export type PendingProof = z.infer<typeof pendingProofSchema>;
export interface VerifiedProof {
  readonly status: 'verified';
  readonly method: ProofMethod;
  readonly token: string;
  readonly verifiedAt: string;
  readonly evidence: string;
}
export type ProofOfControl = PendingProof | VerifiedProof;

export function pendingProof(token: string): PendingProof {
  return { status: 'pending', token, issuedAt: new Date().toISOString() };
}

export function verifiedProof(token: string, method: ProofMethod, evidence: string): VerifiedProof {
  return { status: 'verified', method, token, verifiedAt: new Date().toISOString(), evidence };
}

/**
 * Read a still-pending challenge token from a target's stored `proof_of_control` (jsonb, unknown
 * shape at the trust boundary). Returns the token only when a valid pending proof is present, else
 * null — so a missing/verified/malformed value means "mint a fresh challenge", never a crash.
 */
export function readPendingToken(raw: unknown): string | null {
  const parsed = pendingProofSchema.safeParse(raw);
  return parsed.success ? parsed.data.token : null;
}

// ── Verification (injected IO) ───────────────────────────────────────────────────────────────────

export interface ProofPorts {
  /** Resolve TXT records for a name (each record may arrive as chunks). node:dns resolveTxt shape. */
  resolveTxt(name: string): Promise<string[][]>;
  /** Resolve a host's A/AAAA addresses — used for the SSRF guard on the well-known fetch. */
  resolveHostIps(host: string): Promise<readonly string[]>;
  /** GET a URL as text, bounded by `timeoutMs`, WITHOUT following cross-host redirects. */
  fetchText(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; body: string }>;
}

export type ProofResult =
  | { readonly verified: true; readonly method: ProofMethod; readonly evidence: string }
  | { readonly verified: false; readonly reason: string };

export interface VerifyOptions {
  /** Restrict to one method; when omitted, try DNS first, then the well-known file. */
  readonly method?: ProofMethod;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Verify proof-of-control for `host` against the issued `token`. Refuses up front for a dangerous
 * host (loopback/private/link-local/metadata) — this runs OUTSIDE the sandbox, so there is no
 * egress firewall backstop and the fetch/lookup must not be turned into an SSRF probe. A negative
 * is always "not proven", never an authorization.
 */
export async function verifyProofOfControl(
  host: string,
  token: string,
  ports: ProofPorts,
  options: VerifyOptions = {},
): Promise<ProofResult> {
  if (isDangerousHost(host)) {
    // Literal loopback/private/metadata host — never a target a user could legitimately own here.
    throw new AuthorizationError('Refusing proof-of-control against a disallowed host');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tryDns = options.method === undefined || options.method === 'dns';
  const tryWellKnown = options.method === undefined || options.method === 'well_known';

  if (tryDns) {
    const dns = await checkDns(host, token, ports);
    if (dns.verified || !tryWellKnown) return dns;
  }
  return checkWellKnown(host, token, ports, timeoutMs);
}

async function checkDns(host: string, token: string, ports: ProofPorts): Promise<ProofResult> {
  const name = dnsChallengeName(host);
  let records: string[][];
  try {
    records = await ports.resolveTxt(name);
  } catch {
    // No record / NXDOMAIN / resolver error — not proven (fail closed), not an exception.
    return { verified: false, reason: 'dns TXT record not found' };
  }
  // A TXT record may be split into chunks; join then trim before an exact match.
  const found = records.some((chunks) => chunks.join('').trim() === token);
  return found
    ? { verified: true, method: 'dns', evidence: name }
    : { verified: false, reason: 'dns TXT record does not match the token' };
}

async function checkWellKnown(
  host: string,
  token: string,
  ports: ProofPorts,
  timeoutMs: number,
): Promise<ProofResult> {
  // SSRF guard for the HTTP egress (no sandbox firewall here): resolve the host and refuse if ANY
  // resolved address is dangerous. Residual DNS-rebind between this check and the fetch is the same
  // name-based-scope residual accepted in ADR-29/D-17; pinning the resolved IP is deferred hardening.
  let ips: readonly string[];
  try {
    ips = await ports.resolveHostIps(host);
  } catch {
    return { verified: false, reason: 'host did not resolve' };
  }
  if (ips.length === 0) {
    return { verified: false, reason: 'host did not resolve' };
  }
  if (ips.some(isDangerousHost)) {
    throw new AuthorizationError('Refusing proof-of-control fetch: host resolves to a disallowed address');
  }

  const url = `https://${host}${WELL_KNOWN_PATH}`;
  let res: { ok: boolean; status: number; body: string };
  try {
    res = await ports.fetchText(url, timeoutMs);
  } catch {
    // Timeout, TLS error, or a refused cross-host redirect — not proven.
    return { verified: false, reason: 'well-known file could not be fetched' };
  }
  if (!res.ok) {
    return { verified: false, reason: `well-known file returned status ${res.status}` };
  }
  // Match the token as a whole trimmed line so trailing whitespace/newlines don't defeat it.
  const found = res.body.split(/\r?\n/).some((line) => line.trim() === token);
  return found
    ? { verified: true, method: 'well_known', evidence: url }
    : { verified: false, reason: 'well-known file does not contain the token' };
}
