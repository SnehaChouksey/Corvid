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
 * Validate raw scope rules (e.g. a `targets.scope_rules` JSON column) into a typed {@link ScopeRules}.
 * Invalid or empty scope is an authorization refusal — terminal and loud (§4), never a soft default.
 */
export function parseScopeRules(value: unknown): ScopeRules {
  const result = scopeRulesSchema.safeParse(value);
  if (!result.success) {
    throw new AuthorizationError('Invalid or empty target scope', {
      context: { issue_count: result.error.issues.length },
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
