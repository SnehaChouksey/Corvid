import type { DailySpend, NewLlmCall, ScanReportData, SpendCeilings } from '@corvid/db';
import type { LlmClient } from '@corvid/llm';
import type { CorvidLogger } from '@corvid/logger';

// The Report Writer (ADR-05/26). It reads the VERIFIED-ONLY projection (`loadData`, whose sole
// implementation is `getScanReportData`) and produces a Report. Two safety properties hold here:
// (1) the report writer's only DATA PORT is `loadData` — the verified-findings projection, which
// never returns a hypothesis's rationale/plan — so the writer's inputs cannot carry unverified
// reasoning (this is a port convention, not a dependency-graph guarantee: @corvid/db is a runtime dep
// and its barrel exposes other reads, so the isolation lives in this single injected port, reviewed);
// (2) the LLM only ANNOTATES the fixed finding list (executive summary + per-finding remediation) —
// the findings themselves are deterministic facts the model can never add to or remove from. The LLM
// client is INJECTED (the package never constructs one), mirroring agent-core, so ADR-01's boundary
// is obvious in the wiring.

export interface GenerateReportInput {
  readonly scanId: string;
}

export interface ReportContext {
  /** The verified-only report data for a scan (target url + verified findings with endpoints). */
  loadData(scanId: string): Promise<ScanReportData | undefined>;
  readonly llm: LlmClient;
  readonly ceilings: SpendCeilings;
  /** Injectable clock so the UTC-day spend rollup bound is deterministic in tests. */
  readonly now: () => Date;
  readonly logger?: CorvidLogger;
  dailySpend(userId: string, since: Date): Promise<DailySpend>;
  recordCall(call: NewLlmCall): Promise<void>;
}
