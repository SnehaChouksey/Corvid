import type { ZodType } from 'zod';

import { buildResult, ZERO_COST } from './result.ts';
import type { LlmClient, LlmCost, LlmMessage, LlmPurpose, LlmResult } from './types.ts';

// In-memory LlmClient for offline tests: no API key, no network. It runs the SAME validation path as
// the real client (buildResult), so a test drives the valid or invalid-output branch purely by
// choosing what `content` to return. It lives in @corvid/llm so the ADR-01 boundary holds — the
// verifier never imports an LLM package, real OR fake.

export interface StubReply {
  /** Raw model output. An object is JSON-stringified; a string is used verbatim (to test bad JSON). */
  readonly content: string | object;
  /** Optional cost override, merged over ZERO_COST. */
  readonly cost?: Partial<LlmCost>;
  readonly model?: string;
}

export type StubHandler = (
  purpose: LlmPurpose,
  messages: readonly LlmMessage[],
) => StubReply | Promise<StubReply>;

export function createStubLlmClient(handler: StubHandler): LlmClient {
  return {
    async complete<T>(
      purpose: LlmPurpose,
      messages: readonly LlmMessage[],
      schema: ZodType<T>,
    ): Promise<LlmResult<T>> {
      const reply = await handler(purpose, messages);
      const content =
        typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content);
      const cost: LlmCost = { ...ZERO_COST, ...reply.cost };
      return buildResult(schema, content, cost, reply.model ?? 'stub');
    },
  };
}
