import type { ZodType } from 'zod';

import type { LlmCost, LlmResult } from './types.ts';

/** A completion whose cost the gateway did not report (or a stub with no cost supplied). */
export const ZERO_COST: LlmCost = {
  costCredits: null,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  isByok: false,
};

/**
 * Turn raw model text into a typed result: parse JSON, then validate against the caller's `schema`
 * (the authority — a model that ignores `response_format` still fails closed here). A parse or
 * validation failure is a normal `ok:false` outcome, never an exception (§4).
 *
 * NEVER logs or echoes `content`: it is model output derived from target data (CODING_STANDARDS §5).
 * The same function backs the real client and the test stub, so both take the identical path.
 */
export function buildResult<T>(
  schema: ZodType<T>,
  content: string,
  cost: LlmCost,
  model: string,
): LlmResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'invalid_output', cost, model };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_output', cost, model };
  }
  return { ok: true, data: parsed.data, cost, model };
}
