import { AuthorizationError } from '@corvid/errors';
import * as z from 'zod';

// The ONE scope source (CODING_STANDARDS §3): a target's scope rules produce BOTH the workflow's
// authorization check and the sandbox's egress allow-list. One derivation, two enforcement points —
// never two hand-maintained copies that could drift, because a drift here means testing a host the
// analyst never authorized. Everything here fails CLOSED: an unparseable URL or empty scope denies.

export const scopeRulesSchema = z
  .object({
    // In-scope hostnames — the host-level egress boundary (ADR-24). At least one, or there is
    // nothing to authorize and nothing to allow out.
    hosts: z.array(z.string().min(1)).min(1),
    // Optional path scoping enforced by http.send (ADR-24); the host firewall can't see paths.
    includePaths: z.array(z.string()).optional(),
    excludePaths: z.array(z.string()).optional(),
  })
  .readonly();

export type ScopeRules = z.infer<typeof scopeRulesSchema>;

export interface OobConfig {
  readonly host: string;
}

/**
 * Hosts that must never be in scope: loopback, private/link-local ranges, the cloud metadata
 * endpoint (169.254.169.254), and localhost. Allowing one would let an authorized scope point the
 * egress allow-list at internal/SSRF-sensitive infrastructure — fail closed (§9). Defense in depth
 * alongside proof-of-control (D-7), which is the primary control that a scope is one you own.
 */
export function isDangerousHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal') return true;

  // IPv6, with or without brackets (a URL hostname keeps the brackets).
  const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (v6.includes(':')) {
    if (v6 === '::1' || v6 === '::') return true; // loopback, unspecified
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique-local fc00::/7
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) {
      return true; // link-local fe80::/10
    }
    // IPv4-mapped (::ffff:127.0.0.1 or the hex ::ffff:7f00:1): reject ALL — an IPv4-mapped address
    // in a scope is never legitimate and decoding every form is error-prone, so fail closed.
    if (v6.startsWith('::ffff:')) return true;
    // IPv4-compatible/embedded dotted form (::127.0.0.1): re-check the trailing v4 segment.
    if (isDangerousIpv4(v6.split(':').pop() ?? '')) return true;
    return false;
  }

  return isDangerousIpv4(h);
}

/** Loopback / private / link-local (incl. 169.254.169.254 cloud metadata) IPv4 ranges. */
function isDangerousIpv4(h: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4 === null) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 0 || a === 127 || a === 10) return true; // unspecified, loopback, private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  return false;
}

/**
 * Validate raw scope rules (e.g. a `targets.scope_rules` JSON column) into a typed {@link ScopeRules}.
 * Invalid, empty, or dangerous-host scope is an authorization refusal — terminal and loud (§4),
 * never a soft default.
 */
export function parseScopeRules(value: unknown): ScopeRules {
  const result = scopeRulesSchema.safeParse(value);
  if (!result.success) {
    throw new AuthorizationError('Invalid or empty target scope', {
      context: { issue_count: result.error.issues.length },
    });
  }
  const dangerous = result.data.hosts.filter(isDangerousHost);
  if (dangerous.length > 0) {
    throw new AuthorizationError('Scope contains a disallowed host (loopback/private/link-local/metadata)', {
      context: { disallowed_count: dangerous.length },
    });
  }
  return result.data;
}

/**
 * Host-level egress allow-list for the E2B sandbox (`allowOut`, with `denyOut: all` as the
 * complement, ADR-22/ADR-24): the target hosts plus the OOB listener, and nothing else. Deduped and
 * lowercased. Derived from the same scope the authorization check uses (§3).
 */
export function deriveEgressAllowList(scope: ScopeRules, oob: OobConfig): readonly string[] {
  const hosts = new Set<string>();
  for (const host of scope.hosts) {
    hosts.add(host.toLowerCase());
  }
  hosts.add(oob.host.toLowerCase());
  return [...hosts];
}

/**
 * Whether a full URL is within scope: its host must be in-scope AND its path must satisfy the
 * include/exclude rules. Used by http.send for path-level scope (ADR-24) — the finer check the
 * host-level firewall structurally can't make. Fails closed: an unparseable URL is out of scope.
 */
export function isUrlInScope(rawUrl: string, scope: ScopeRules): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();
  if (!scope.hosts.some((h) => h.toLowerCase() === host)) {
    return false;
  }

  const path = url.pathname;
  if (scope.excludePaths?.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  if (scope.includePaths !== undefined && scope.includePaths.length > 0) {
    return scope.includePaths.some((prefix) => path.startsWith(prefix));
  }
  return true;
}
