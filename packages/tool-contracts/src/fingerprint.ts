import { createHash } from 'node:crypto';

import type { HttpMethod } from './crawler.ts';
import type { VulnClass } from './domain.ts';

// Deterministic hypothesis fingerprint (D-10 / ADR-D10): a per-scan dedup key computed from
// `vuln_class + normalized method+path + parameter name + payload family`. Purpose: re-testing the
// same weakness with a variant payload dedups (payload *family*, not the exact payload, is keyed),
// while a genuinely different class/param/endpoint does not. The path is normalized so trivially
// different URLs for one endpoint collapse (trailing slashes, id-like segments templated).
//
// Per-scan scoping is applied by the caller via the Redis key namespace (`scan:{id}:fp`), NOT here —
// this function is a pure, side-effect-free hash so it is trivially testable and identical across
// call sites. Non-LLM and deterministic by construction (no model ever computes a fingerprint).
//
// The normalization/family buckets are a calibrated heuristic (ADR-D10 says "calibrate against the
// labs"); this is the v1 baseline. Widening it is an additive change, not a contract break.

// ASCII Unit Separator: joins the fingerprint fields so no field's contents can be mistaken for a
// boundary between fields. It cannot appear in a URL, an HTTP method, or a vuln-class enum value.
const FIELD_SEP = String.fromCharCode(0x1f);

export interface FingerprintInput {
  readonly vulnClass: VulnClass;
  readonly method: HttpMethod;
  /** Full endpoint URL; only the path is fingerprinted (query/host are normalized away). */
  readonly url: string;
  /** The parameter the test targets, if any. Class-level tests (e.g. a bare JWT) omit it. */
  readonly paramName?: string;
  /** Technique bucket, not an exact payload (ADR-D10). */
  readonly payloadFamily: string;
}

/** A path segment that looks like a record id, so two ids for the same route collapse to one key. */
function isIdLike(segment: string): boolean {
  if (segment === '') return false;
  if (/^\d+$/.test(segment)) return true; // pure numeric id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true; // uuid
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true; // long hex (object id / hash)
  return false;
}

/**
 * Normalize a URL to a stable path key: strip query/fragment and host, drop a trailing slash, and
 * template id-like segments to `{id}`. `/users/42/posts/` and `/users/99/posts` both become
 * `/users/{id}/posts`.
 */
export function normalizePath(rawUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    // Not an absolute URL — take everything before the query/fragment.
    pathname = rawUrl.split(/[?#]/, 1)[0] ?? rawUrl;
  }
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, ''); // drop trailing slash, keep root
  const normalized = pathname
    .split('/')
    .map((segment) => (isIdLike(segment) ? '{id}' : segment))
    .join('/');
  return normalized === '' ? '/' : normalized;
}

/** Compute the per-scan dedup fingerprint (hex SHA-256) for a hypothesis (D-10 / ADR-D10). */
export function fingerprint(input: FingerprintInput): string {
  const canonical = [
    input.vulnClass,
    input.method.toUpperCase(),
    normalizePath(input.url),
    input.paramName ?? '',
    input.payloadFamily,
  ].join(FIELD_SEP);
  return createHash('sha256').update(canonical).digest('hex');
}
