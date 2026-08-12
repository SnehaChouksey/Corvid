// Daily LLM spend hard-stop (ADR-21). Pure decision logic — no DB, no clock — so it is trivially
// testable and behaves identically everywhere. The daily sums come from `sumDailyLlmSpend`; the
// ceilings are config (D-12), defaulting conservative and raised once Unit 8 measures real cost.
//
// The kill-switch degrades reasoning throughput only, never the verification gate (which is non-LLM,
// ADR-01) — so it is safe to fail closed here.

export interface SpendCeilings {
  /** Global daily ceiling in credits, summed across all users. */
  readonly globalCeilingCredits: number;
  /** Per-user daily ceiling in credits. */
  readonly userCeilingCredits: number;
}

/** D-12: conservative defaults (credits ≈ USD), raised deliberately after Unit 8 measures cost. */
export const DEFAULT_DAILY_SPEND_CEILINGS: SpendCeilings = {
  globalCeilingCredits: 5,
  userCeilingCredits: 1,
};

export interface DailySpend {
  readonly globalSpentCredits: number;
  readonly userSpentCredits: number;
}

export type SpendDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly trippedScope: 'global' | 'user' };

/**
 * Decide whether another LLM-billed call is permitted. Fail closed: a non-finite or non-positive
 * ceiling (misconfiguration) refuses rather than allowing unbounded spend. The global ceiling is
 * checked first, so a simultaneous over-limit is reported as `global`.
 */
export function evaluateDailySpend(spent: DailySpend, ceilings: SpendCeilings): SpendDecision {
  const validCeiling = (c: number): boolean => Number.isFinite(c) && c > 0;
  if (!validCeiling(ceilings.globalCeilingCredits) || !validCeiling(ceilings.userCeilingCredits)) {
    return { allowed: false, trippedScope: 'global' };
  }
  if (spent.globalSpentCredits >= ceilings.globalCeilingCredits) {
    return { allowed: false, trippedScope: 'global' };
  }
  if (spent.userSpentCredits >= ceilings.userCeilingCredits) {
    return { allowed: false, trippedScope: 'user' };
  }
  return { allowed: true };
}

/**
 * Start of the UTC day containing `now` — the lower bound for the daily rollup. The cap resets at
 * UTC midnight (ADR-21), so callers pass `utcDayStart(new Date())` as the `since` bound.
 */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
