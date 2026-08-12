import type { Database, SpendCeilings } from '@corvid/db';
import {
  DEFAULT_DAILY_SPEND_CEILINGS,
  insertHypotheses,
  listHypothesesForScan,
  recordLlmCall,
  setHypothesisPlan,
  sumDailyLlmSpend,
} from '@corvid/db';
import type { LlmClient } from '@corvid/llm';
import type { CorvidLogger } from '@corvid/logger';
import type { HypothesisDedup } from '@corvid/redis';

import type { HypothesizeContext, PlanContext } from './types.ts';

// The real ports: bind the node contexts to @corvid/db + @corvid/redis. Kept here (not in the node
// modules) so the nodes stay pure and testable with in-memory fakes. `dedupFor` is a factory rather
// than a raw Redis client so this package needn't depend on ioredis directly.

export interface HypothesizeAdapterDeps {
  readonly db: Database;
  readonly llm: LlmClient;
  /** Build the per-scan dedup cache (e.g. `(scanId) => new HypothesisDedup(redis, scanId)`). */
  readonly dedupFor: (scanId: string) => HypothesisDedup;
  readonly ceilings?: SpendCeilings;
  readonly now?: () => Date;
  readonly logger?: CorvidLogger;
}

export function createHypothesizeContext(deps: HypothesizeAdapterDeps): HypothesizeContext {
  return {
    llm: deps.llm,
    ceilings: deps.ceilings ?? DEFAULT_DAILY_SPEND_CEILINGS,
    now: deps.now ?? ((): Date => new Date()),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    dailySpend: (userId, since) => sumDailyLlmSpend(deps.db, { userId, since }),
    recordCall: (call) => recordLlmCall(deps.db, call),
    persist: (rows) => insertHypotheses(deps.db, rows),
    markSeen: (scanId, fingerprints) =>
      deps.dedupFor(scanId)
        .filterUnseen(fingerprints)
        .then(() => undefined),
  };
}

export interface PlanAdapterDeps {
  readonly db: Database;
  readonly logger?: CorvidLogger;
}

export function createPlanContext(deps: PlanAdapterDeps): PlanContext {
  return {
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    listPending: (scanId) =>
      listHypothesesForScan(deps.db, scanId).then((rows) => rows.filter((h) => h.status === 'pending')),
    setPlan: (scanId, hypothesisId, plan) =>
      setHypothesisPlan(deps.db, scanId, hypothesisId, plan).then(() => undefined),
  };
}
