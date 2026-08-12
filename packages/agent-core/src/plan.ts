import type { HypothesisRow } from '@corvid/db';
import type { HypothesisPlan, VulnClass } from '@corvid/tool-contracts';

import type { PlanContext, PlanOutcome } from './types.ts';

// The plan node (ADR-10): for each pending hypothesis, select the tester and describe the intended
// payload the analyst approves (`02` §6). It does NOT send anything — the act/observe/verify nodes
// (Units 4–5) do. Idempotent: a hypothesis already carrying a tool + intended payload is skipped, so
// a replay on resume (ADR-27) is a no-op.

/** vuln class → the Unit 4 MCP tool that tests it (`02` §10). */
const TOOL_BY_CLASS: Readonly<Record<VulnClass, string>> = {
  jwt: 'jwt.mutate_test',
  injection: 'injection.fuzz',
  ssrf: 'ssrf.check',
  idor: 'idor.compare',
};

function describeIntendedPayload(row: HypothesisRow, base: HypothesisPlan, tool: string): string {
  const target =
    base.param !== undefined ? `${base.param.location} parameter "${base.param.name}"` : 'the request';
  return `Test ${row.vulnClass.toUpperCase()} (${base.payloadFamily}) against ${target} on ${row.endpoint}, via ${tool}.`;
}

export async function plan(ctx: PlanContext, scanId: string): Promise<PlanOutcome> {
  const pending = await ctx.listPending(scanId);
  let planned = 0;

  for (const row of pending) {
    const base = row.plan;
    if (base === null || base === undefined) {
      // A pending hypothesis with no base plan shouldn't occur (hypothesize always writes one);
      // skip rather than fabricate a plan for a row we can't ground.
      ctx.logger?.warn({ scanId, hypothesisId: row.id }, 'plan: pending hypothesis has no base plan; skipped');
      continue;
    }
    if (base.tool !== undefined && base.intendedPayload !== undefined) continue; // already planned (idempotent)

    const tool = TOOL_BY_CLASS[row.vulnClass];
    const enriched: HypothesisPlan = {
      ...base,
      tool,
      intendedPayload: describeIntendedPayload(row, base, tool),
    };
    await ctx.setPlan(scanId, row.id, enriched);
    planned++;
  }

  return { planned };
}
