// Pure classification of an inbound request by its Host header (no I/O, unit-testable). The listener
// serves two roles on one process, told apart by host:
//   - the apex `OOB_HOST` is the internal control plane (register a token / query a callback);
//   - `<token>.<OOB_HOST>` is a callback — the target's server-side fetch reached us out of band.
// Any other host is ignored (not ours). The token is the leftmost DNS label; correlation to a
// registered token happens in the store, so an arbitrary `<junk>.<OOB_HOST>` probe is harmless.

import { OOB_TOKEN } from '@corvid/redis';

export type HostClassification =
  | { readonly kind: 'control' }
  | { readonly kind: 'callback'; readonly token: string }
  | { readonly kind: 'ignore' };

/** Strip an optional `:port` and lowercase; Host headers may carry either. */
function normalizeHost(hostHeader: string): string {
  const withoutPort = hostHeader.split(':', 1)[0] ?? '';
  return withoutPort.trim().toLowerCase();
}

export function classifyHost(hostHeader: string | undefined, oobHost: string): HostClassification {
  if (hostHeader === undefined || hostHeader.length === 0) return { kind: 'ignore' };
  const host = normalizeHost(hostHeader);
  const apex = oobHost.trim().toLowerCase();
  if (host.length === 0 || apex.length === 0) return { kind: 'ignore' };

  if (host === apex) return { kind: 'control' };

  const suffix = `.${apex}`;
  if (!host.endsWith(suffix)) return { kind: 'ignore' };

  // A callback host is EXACTLY `<token>.<apex>` — the prefix must be a single label matching the
  // fixed token shape. A multi-label prefix (`<token>.extra.<apex>`) or a malformed one is ignored
  // rather than treated as a never-registered token (the Host header is attacker-controlled).
  const prefix = host.slice(0, host.length - suffix.length);
  if (!OOB_TOKEN.test(prefix)) return { kind: 'ignore' };
  return { kind: 'callback', token: prefix };
}
