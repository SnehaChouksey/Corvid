import type { DailySpend, NewLlmCall, ScanReportData, SpendCeilings } from '@corvid/db';
import type { LlmClient } from '@corvid/llm';
import type { CorvidLogger } from '@corvid/logger';

// The Report Writer (ADR-05/26). It reads the VERIFIED-ONLY projection (`loadData`, whose sole
// implementation is `getScanReportData`) and produces a Report. Two safety properties are structural
// here: (1) the only data path is the verified-findings projection — there is no port that returns a
// hypothesis's rationale, so the writer cannot see unverified reasoning; (2) the LLM only ANNOTATES
// the fixed finding list (executive summary + per-finding remediation) — the findings themselves are
// deterministic facts the model can never add to or remove from. The LLM client is INJECTED (the
// package never constructs one), mirroring agent-core, so ADR-01's boundary is obvious in the wiring.

export interface GenerateReportInput {
  readonly scanId: string;
  /** The scan owner — carried so per-user spend + cost recording don't re-derive it (ADR-21). */
  readonly userId: string;
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
