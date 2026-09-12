// Pure classification of an inbound request by its URL PATH (no I/O, unit-testable). Path-token scheme
// (ADR-36): the listener serves on ONE public host — no wildcard DNS — and tells its two roles apart by
// the first path segment:
//   - `<base>/<token>` is a callback — the target's server-side fetch reached us out of band. The token
//     is the first path segment; correlation to a registered token happens in the store, so an
//     arbitrary `<base>/<junk>` probe is harmless.
//   - every other path (`/register`, `/callbacks/:token`, anything else) is left for the control routes,
//     which are bearer-gated; an unmatched path 404s.
// Host is deliberately NOT part of the decision: behind a tunnel or reverse proxy the Host header is
// rewritten, and correlation (an unguessable 128-bit token) — not the host — is the real guard.

import { OOB_TOKEN } from '@corvid/redis';

export type RequestClassification =
  | { readonly kind: 'callback'; readonly token: string }
  | { readonly kind: 'control' };

/**
 * Classify by the first path segment. A token-shaped first segment is a callback; anything else
 * (including `register` and `callbacks`, which are never token-shaped) falls through to the control
 * routes. The token match is exact against the fixed shape, so a malformed segment is never treated as
 * a token — it just isn't a callback.
 */
export function classifyPath(pathname: string): RequestClassification {
  const firstSegment = pathname.replace(/^\/+/, '').split('/', 1)[0] ?? '';
  const token = firstSegment.trim().toLowerCase();
  if (OOB_TOKEN.test(token)) return { kind: 'callback', token };
  return { kind: 'control' };
}
