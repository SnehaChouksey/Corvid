import type { NewHypothesis } from '@corvid/db';
import { evaluateDailySpend, utcDayStart } from '@corvid/db';
import { fingerprint, hypothesisGenerationSchema, type HypothesisPlan } from '@corvid/tool-contracts';

import { buildHypothesizeMessages } from './prompt.ts';
import type { HypothesizeContext, HypothesizeInput, HypothesizeOutcome } from './types.ts';

// The hypothesize node (ADR-10). Order of guarantees:
//   1. Enforce the daily LLM spend cap BEFORE spending (ADR-21) — refuse (retryable) if tripped.
//   2. Call the LLM, then record its cost AT THE CALL SITE, before acting on the parse result — a
//      garbage response still costs money (ADR-21).
//   3. Malformed/empty-from-malformed output pauses the scan (generation_error, `01` §12); it is
//      never treated as "no hypotheses".
//   4. Persist via an onConflictDoNothing upsert (the ctx.persist port) — replay-safe (ADR-27).
// The LLM never verifies and never sends a payload; it only proposes `pending` hypotheses.

export async function hypothesize(
  ctx: HypothesizeContext,
  input: HypothesizeInput,
): Promise<HypothesizeOutcome> {
  // 1. Spend hard-stop (fail closed): refuse before spending if the daily cap is reached.
  const since = utcDayStart(ctx.now());
  const spent = await ctx.dailySpend(input.userId, since);
  const decision = evaluateDailySpend(spent, ctx.ceilings);
  if (!decision.allowed) {
    ctx.logger?.warn(
      { scanId: input.scanId, scope: decision.trippedScope },
      'hypothesize refused: daily LLM spend cap reached',
    );
    return { kind: 'spend_stopped', scope: decision.trippedScope };
  }

  // 2. Generate.
  const messages = buildHypothesizeMessages(input.surface);
  const result = await ctx.llm.complete('hypothesize', messages, hypothesisGenerationSchema);

  // Record cost at the call site BEFORE parsing/acting — a garbage response still bills (ADR-21).
  await ctx.recordCall({
    scanId: input.scanId,
    userId: input.userId,
    purpose: 'hypothesize',
    model: result.model,
    costCredits: result.cost.costCredits,
    promptTokens: result.cost.promptTokens,
    completionTokens: result.cost.completionTokens,
    totalTokens: result.cost.totalTokens,
    isByok: result.cost.isByok,
  });

  // 3. Invalid output pauses the scan — never proceed-on-empty (`01` §12).
  if (!result.ok) {
    ctx.logger?.warn({ scanId: input.scanId }, 'hypothesize produced invalid output — pausing scan');
    return { kind: 'generation_error' };
  }

  // 4. Build hypotheses, de-duplicating the batch in memory by fingerprint (no intra-batch conflict).
  const byFingerprint = new Map<string, NewHypothesis>();
  for (const c of result.data.hypotheses) {
    const fp = fingerprint({
      vulnClass: c.vulnClass,
      method: c.method,
      url: c.url,
      ...(c.param ? { paramName: c.param.name } : {}),
      payloadFamily: c.payloadFamily,
    });
    if (byFingerprint.has(fp)) continue;
    const plan: HypothesisPlan = {
      method: c.method,
      payloadFamily: c.payloadFamily,
      ...(c.param ? { param: c.param } : {}),
    };
    byFingerprint.set(fp, {
      scanId: input.scanId,
      vulnClass: c.vulnClass,
      endpoint: `${c.method} ${c.url}`,
      rationale: c.rationale,
      fingerprint: fp,
      plan,
    });
  }
  const candidates = [...byFingerprint.values()];

  // The DB unique (scan_id, fingerprint) + onConflictDoNothing is the durable dedup authority: a
  // replayed node re-inserts the same fingerprints as a no-op and gets back [] (ADR-27).
  const inserted = await ctx.persist(candidates);

  // Warm the per-scan Redis dedup cache (best-effort). The DB already guarantees dedup, so a cache
  // failure must not fail a node whose durable write already succeeded — log and continue.
  try {
    await ctx.markSeen(
      input.scanId,
      candidates.map((c) => c.fingerprint),
    );
  } catch (err) {
    ctx.logger?.warn(
      { scanId: input.scanId, err },
      'hypothesis dedup cache warm failed (non-fatal; DB dedup is authoritative)',
    );
  }

  return {
    kind: 'generated',
    inserted,
    deduped: result.data.hypotheses.length - inserted.length,
  };
}
