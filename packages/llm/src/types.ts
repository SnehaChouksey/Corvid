import type { ZodType } from 'zod';

// @corvid/llm is the ONE place in the repo that talks to an LLM (ADR-01/ADR-23). The deterministic
// verification gate (Unit 5) must never import this package — verification is non-LLM, structurally.
// Callers name a *purpose*, never a model slug: slugs live only in this package (ADR-23).

export type LlmPurpose = 'hypothesize' | 'report';

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** Per-call spend + usage, read by the ADR-21 recorder/kill-switch. Populated even on invalid output. */
export interface LlmCost {
  /**
   * Cost in OpenRouter credits (USD), or null if the gateway didn't report it. Under BYOK this is
   * only OpenRouter's surcharge — upstream inference is billed to the provider key, so it can be ~0.
   */
  readonly costCredits: number | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** True when the request used a Bring-Your-Own-Key provider key (`usage.is_byok`). */
  readonly isByok: boolean;
}

/**
 * The outcome of a completion. `ok:true` carries validated `data`; `ok:false` means the model's
 * output did not satisfy the caller's schema — a normal domain outcome, NOT an exception. Either
 * way `cost` is set so the caller records spend BEFORE acting on the result (ADR-21). Transport /
 * gateway failures are thrown as `InfraError`, never folded into `ok:false` (a tooling error is
 * never a clean negative — CODING_STANDARDS §4).
 */
export type LlmResult<T> =
  | { readonly ok: true; readonly data: T; readonly cost: LlmCost; readonly model: string }
  | { readonly ok: false; readonly reason: 'invalid_output'; readonly cost: LlmCost; readonly model: string };

export interface LlmClient {
  complete<T>(
    purpose: LlmPurpose,
    messages: readonly LlmMessage[],
    schema: ZodType<T>,
  ): Promise<LlmResult<T>>;
}
