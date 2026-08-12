import type { CorvidLogger } from '@corvid/logger';
import type { ScopeRules } from '@corvid/scope';
import type { HttpResponse, HttpSendInput, HttpSendOutput } from '@corvid/tool-contracts';

// @corvid/http-send is the SINGLE code path every tester's traffic flows through (Unit 4, ADR-24/25).
// Because it is a direct function call (a shared library, not a network hop), a payload structurally
// cannot reach the target except through it. The enforcement order is fixed in `send.ts`:
// authorization → path scope → dedup → rate posture → fetch → audit. Dependencies are injected as
// ports so the whole thing is unit-testable with no DB, no Redis, and no network.

export interface ResolvedTarget {
  readonly scope: ScopeRules;
  /** Whether the target has recorded authorization (targets.authorization_confirmed_at is set). */
  readonly authorized: boolean;
}

export interface FetchRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface HttpAuditEntry {
  readonly scanId: string;
  readonly action: string;
  /** Safe metadata only — never a raw URL query, header, or body (may carry secrets/tokens, §5). */
  readonly detail?: string;
}

/** Conservative rate posture (D-2/ADR-D2): a min-delay between requests, grown on a throttle signal. */
export interface RateConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
}

export const DEFAULT_RATE_CONFIG: RateConfig = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  backoffMultiplier: 2,
};

export interface HttpSendPorts {
  /** Resolve the scan's recorded scope + authorization from the target row (the ONE scope source). */
  resolveTarget(scanId: string): Promise<ResolvedTarget | undefined>;
  /** Per-scan dedup: true if the request key is NEW (marks it), false if already sent. Fail-closed. */
  markNewRequest(scanId: string, requestKey: string): Promise<boolean>;
  /** The actual network send — real `fetch` inside the E2B sandbox in prod; a fake in tests. */
  fetch(req: FetchRequest): Promise<HttpResponse>;
  audit(entry: HttpAuditEntry): Promise<void>;
  readonly config?: RateConfig;
  /** Injectable so tests don't actually sleep; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly logger?: CorvidLogger;
}

export interface HttpSender {
  send(input: HttpSendInput): Promise<HttpSendOutput>;
}
