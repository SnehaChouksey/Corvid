import { AuthorizationError } from '@corvid/errors';
import { deriveEgressAllowList, type OobConfig, type ScopeRules } from '@corvid/scope';

// Per-testing-burst sandbox skeleton (ADR-22). Two enforcement layers computed from ONE scope
// (§3, ADR-03/08): (1) the workflow refuses to create a sandbox for a target without recorded
// authorization; (2) the sandbox's egress allow-list is derived from that same scope — deny all,
// allow only the target hosts + OOB listener. Neither layer trusts the other. The E2B client is
// behind SandboxFactory so the authorization + egress logic is testable without an API key; the
// real firewall is proven live once E2B_API_KEY exists (Unit 0).
//
// NOTE (§7): never read a socket/connect success inside the sandbox as reachability — E2B can
// accept-then-drop a denied egress. Proof is always an application-level/OOB signal, enforced by
// the tool servers (Units 4–5), not here.

/** 0.0.0.0/0 — "all traffic", the deny-everything base the allow-list punches holes in. */
const ALL_TRAFFIC = '0.0.0.0/0';
/** Fail-closed backstop; a burst is explicitly torn down, this only bounds a leaked sandbox. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface RecordedAuthorization {
  /** Non-null iff authorization (with proof-of-control, D-7) is recorded for the CURRENT scope. */
  readonly confirmedAt: Date | null;
}

export interface EgressConfig {
  readonly denyOut: readonly string[];
  readonly allowOut: readonly string[];
}

export interface SandboxCreateOptions {
  readonly network: EgressConfig;
  readonly timeoutMs: number;
}

export interface RunningSandbox {
  readonly sandboxId: string;
  kill(): Promise<void>;
}

/** Indirection over E2B so the authorization/egress derivation is unit-testable without a key. */
export interface SandboxFactory {
  create(options: SandboxCreateOptions): Promise<RunningSandbox>;
}

export interface CreatedTestingSandbox extends RunningSandbox {
  /** The host-level egress allow-list actually applied — surfaced for auditing. */
  readonly allowOut: readonly string[];
}

export interface TestingSandboxRequest {
  readonly scope: ScopeRules;
  readonly oob: OobConfig;
  readonly authorization: RecordedAuthorization;
  readonly timeoutMs?: number;
}

/**
 * Create the per-burst testing sandbox. Refuses (before touching E2B) if authorization isn't
 * recorded for the current scope, then derives the egress allow-list from that same scope.
 */
export async function createTestingSandbox(
  factory: SandboxFactory,
  request: TestingSandboxRequest,
): Promise<CreatedTestingSandbox> {
  // Layer 1 — workflow authorization. Assert the POSITIVE (a real confirmed date), so a missing/
  // undefined/malformed value fails closed rather than slipping through a `=== null` check. Never
  // create a sandbox to attack a target the analyst didn't authorize.
  const confirmedAt = request.authorization.confirmedAt;
  if (!(confirmedAt instanceof Date) || Number.isNaN(confirmedAt.getTime())) {
    throw new AuthorizationError(
      'Refusing to create a testing sandbox: no recorded authorization for the current scope',
    );
  }

  // Layer 2 — egress allow-list from the SAME scope (one derivation, ADR-24). denyOut: all.
  const allowOut = deriveEgressAllowList(request.scope, request.oob);
  const running = await factory.create({
    network: { denyOut: [ALL_TRAFFIC], allowOut },
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return { sandboxId: running.sandboxId, allowOut, kill: running.kill.bind(running) };
}
