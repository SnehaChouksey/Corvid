import { evaluateDailySpend, utcDayStart, type ReportFindingData } from '@corvid/db';
import { parseSeverity, type Report, type ReportFinding } from '@corvid/tool-contracts';

import { buildReportMessages, reportNarrativeSchema } from './prompt.ts';
import type { GenerateReportInput, ReportContext } from './types.ts';

// The Report Writer (ADR-05/26, D-3). Produces a verified-only Report:
//   1. Load the verified-only projection (the sole data path — no unverified reasoning reachable).
//   2. Assemble deterministic finding facts (class/endpoint/payload/proof/CVSS), sorted by severity.
//   3. A zero-finding scan → an honest clean report, with NO billed LLM call.
//   4. Otherwise, enforce the daily spend cap, then call the LLM for the NARRATIVE only, recording
//      cost at the call site BEFORE using the result (ADR-21). A spend stop or invalid model output
//      degrades the narrative (neutral summary, no remediation) but NEVER the verified facts — the
//      report always ships its findings (the spend cap degrades reasoning, not integrity, ADR-21).
// The LLM can only annotate the fixed finding list; it can never add or remove a finding.

function toReportFinding(data: ReportFindingData): ReportFinding {
  const s = parseSeverity(data.severity);
  return {
    vulnClass: data.vulnClass,
    endpoint: data.endpoint,
    payload: data.payload,
    proof: data.proof,
    severity: { score: s.score, vector: s.vector, band: s.band, raw: data.severity },
    remediation: null,
    reportedAt: data.reportedAt.toISOString(),
  };
}

/** Sort highest-severity first; a finding with no numeric score sorts last (never above a scored one). */
function bySeverityDesc(a: ReportFinding, b: ReportFinding): number {
  return (b.severity.score ?? -1) - (a.severity.score ?? -1);
}

function cleanSummary(): string {
  return 'No verified vulnerabilities were found. Every hypothesis was either not confirmed by the deterministic verification gate or rejected at the approval gate.';
}

function factualSummary(findings: readonly ReportFinding[]): string {
  const classes = [...new Set(findings.map((f) => f.vulnClass))].sort().join(', ');
  const n = findings.length;
  return `${n} verified ${n === 1 ? 'vulnerability was' : 'vulnerabilities were'} confirmed by the deterministic verification gate (${classes}).`;
}

export async function generateReport(ctx: ReportContext, input: GenerateReportInput): Promise<Report> {
  const data = await ctx.loadData(input.scanId);
  if (data === undefined) {
    // The scan row is gone — a logic/infra condition, never a "clean report". Let it surface so the
    // job retries rather than persisting an empty artifact for a nonexistent scan.
    throw new Error(`generateReport: no scan data for ${input.scanId}`);
  }
  const userId = data.ownerId; // spend + cost attribution follow the scan owner (ADR-21)

  const findings = data.findings.map(toReportFinding).sort(bySeverityDesc);
  const generatedAt = ctx.now().toISOString();
  const base = {
    scanId: input.scanId,
    generatedAt,
    target: { url: data.targetUrl },
    findings,
  };

  // 3. Clean report — honest, and cost-free (no LLM call for a zero-finding scan).
  if (findings.length === 0) {
    return { ...base, summary: cleanSummary(), clean: true };
  }

  // 4a. Spend hard-stop (fail closed for the narrative only): ship the factual report without prose.
  const decision = evaluateDailySpend(await ctx.dailySpend(userId, utcDayStart(ctx.now())), ctx.ceilings);
  if (!decision.allowed) {
    ctx.logger?.warn(
      { scanId: input.scanId, scope: decision.trippedScope },
      'report narrative skipped: daily LLM spend cap reached (facts still reported)',
    );
    return { ...base, summary: factualSummary(findings), clean: false };
  }

  // 4b. Narrative call — record cost at the call site BEFORE acting on the result (ADR-21). A gateway
  // outage / 402 / 429 / 5xx throws InfraError (not `ok:false`); that must NOT throw away the verified
  // facts — degrade to the factual report, same as a spend stop. The narrative is an enrichment; the
  // verified findings are the artifact (ADR-05/21). This is the most likely failure (OpenRouter down /
  // out of credit), so it is handled, not propagated.
  let result;
  try {
    result = await ctx.llm.complete('report', buildReportMessages(base.target, findings), reportNarrativeSchema);
  } catch (err) {
    ctx.logger?.warn(
      { scanId: input.scanId, err_name: err instanceof Error ? err.name : 'unknown' },
      'report narrative unavailable (LLM gateway error) — reporting facts without prose',
    );
    return { ...base, summary: factualSummary(findings), clean: false };
  }
  await ctx.recordCall({
    scanId: input.scanId,
    userId,
    purpose: 'report',
    model: result.model,
    costCredits: result.cost.costCredits,
    promptTokens: result.cost.promptTokens,
    completionTokens: result.cost.completionTokens,
    totalTokens: result.cost.totalTokens,
    isByok: result.cost.isByok,
  });

  if (!result.ok) {
    ctx.logger?.warn({ scanId: input.scanId }, 'report narrative invalid — reporting facts without prose');
    return { ...base, summary: factualSummary(findings), clean: false };
  }

  // Apply remediation prose by index; a missing/extra entry degrades to no guidance for that finding.
  const byIndex = new Map(result.data.remediations.map((r) => [r.index, r.guidance]));
  const annotated: ReportFinding[] = findings.map((f, i) => {
    const guidance = byIndex.get(i);
    return guidance === undefined ? f : { ...f, remediation: guidance };
  });
  return { ...base, findings: annotated, summary: result.data.executiveSummary, clean: false };
}
