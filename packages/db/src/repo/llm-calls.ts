import { gte, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { llmCalls } from '../schema/domain.ts';

export type LlmCallRow = typeof llmCalls.$inferSelect;

export interface NewLlmCall {
  readonly scanId: string;
  readonly userId: string;
  readonly purpose: 'hypothesize' | 'report';
  readonly model: string;
  /** OpenRouter `usage.cost` in credits, or null when the gateway didn't report it. */
  readonly costCredits: number | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly isByok: boolean;
}

/**
 * Record one LLM call's cost at the call site (ADR-21). Written for BOTH successful and
 * invalid-output completions — a garbage response still costs money and still counts toward the cap.
 */
export async function recordLlmCall(db: Database, call: NewLlmCall): Promise<void> {
  await db.insert(llmCalls).values({
    scanId: call.scanId,
    userId: call.userId,
    purpose: call.purpose,
    model: call.model,
    // `numeric` is a precision-preserving string column in Drizzle; null stays null.
    costCredits: call.costCredits === null ? null : call.costCredits.toString(),
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
    totalTokens: call.totalTokens,
    isByok: call.isByok,
  });
}

export interface DailyLlmSpend {
  readonly globalSpentCredits: number;
  readonly userSpentCredits: number;
}

/**
 * Sum recorded LLM credit-cost since `since` (the current UTC-day start) — globally and for one
 * user, in a single query. NULL costs (unreported / BYOK) contribute 0. The kill-switch reads this.
 */
export async function sumDailyLlmSpend(
  db: Database,
  params: { readonly userId: string; readonly since: Date },
): Promise<DailyLlmSpend> {
  const rows = await db
    .select({
      global: sql<string>`coalesce(sum(${llmCalls.costCredits}), 0)`,
      user: sql<string>`coalesce(sum(${llmCalls.costCredits}) filter (where ${llmCalls.userId} = ${params.userId}), 0)`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, params.since));
  const row = rows[0];
  return {
    globalSpentCredits: row ? Number(row.global) : 0,
    userSpentCredits: row ? Number(row.user) : 0,
  };
}
