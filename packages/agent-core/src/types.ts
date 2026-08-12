import type {
  AuthFlowKind,
  CrawledParam,
  EndpointSource,
  HttpMethod,
  HypothesisPlan,
} from '@corvid/tool-contracts';
import type { DailySpend, HypothesisRow, NewHypothesis, NewLlmCall, SpendCeilings } from '@corvid/db';
import type { LlmClient } from '@corvid/llm';
import type { CorvidLogger } from '@corvid/logger';

// Agent-core is the LLM reasoning boundary (ADR-10). The nodes (perceive → hypothesize → plan) are
// plain, dependency-injected functions so each is unit-testable in isolation with a fake LLM client
// and in-memory ports — no live target, no network (Unit 3 DoD). Slab 6 wires them into the durable
// LangGraph graph (@corvid/scan-runtime). The LLM only ever hypothesizes/plans; it never verifies.

/** A crawl endpoint normalized for reasoning — duplicates merged, params unioned. */
export interface PerceivedEndpoint {
  readonly url: string;
  readonly method: HttpMethod;
  readonly source: EndpointSource;
  readonly params: readonly CrawledParam[];
}

export interface PerceivedAuthFlow {
  readonly kind: AuthFlowKind;
  readonly url: string;
}

/** The attack surface the `hypothesize` node reasons over — the crawl map, de-duplicated. */
export interface PerceivedSurface {
  readonly endpoints: readonly PerceivedEndpoint[];
  readonly authFlows: readonly PerceivedAuthFlow[];
  readonly stats: {
    readonly endpointCount: number;
    readonly parameterizedCount: number;
    readonly authFlowCount: number;
  };
}

// ---- hypothesize node ----

export interface HypothesizeInput {
  readonly scanId: string;
  /** The scan owner — carried so per-user spend + cost recording don't re-derive it (ADR-21). */
  readonly userId: string;
  readonly surface: PerceivedSurface;
}

/**
 * The hypothesize node's side-effecting dependencies as small ports. The real adapter binds these to
 * @corvid/db + @corvid/redis (`createHypothesizeContext`); tests pass in-memory fakes, so the node's
 * logic is exercised with no DB, no Redis, and a stub LLM client.
 */
export interface HypothesizeContext {
  readonly llm: LlmClient;
  readonly ceilings: SpendCeilings;
  /** Injectable clock so the UTC-day rollup bound is deterministic in tests. */
  readonly now: () => Date;
  readonly logger?: CorvidLogger;
  dailySpend(userId: string, since: Date): Promise<DailySpend>;
  recordCall(call: NewLlmCall): Promise<void>;
  persist(rows: readonly NewHypothesis[]): Promise<HypothesisRow[]>;
  markSeen(scanId: string, fingerprints: readonly string[]): Promise<void>;
}

export type HypothesizeOutcome =
  | { readonly kind: 'generated'; readonly inserted: readonly HypothesisRow[]; readonly deduped: number }
  | { readonly kind: 'spend_stopped'; readonly scope: 'global' | 'user' }
  | { readonly kind: 'generation_error' };

// ---- plan node ----

export interface PlanContext {
  readonly logger?: CorvidLogger;
  listPending(scanId: string): Promise<readonly HypothesisRow[]>;
  setPlan(scanId: string, hypothesisId: string, plan: HypothesisPlan): Promise<void>;
}

export interface PlanOutcome {
  readonly planned: number;
}
