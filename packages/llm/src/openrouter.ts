import { InfraError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import * as z from 'zod';

import { buildResult, ZERO_COST } from './result.ts';
import type { LlmClient, LlmCost, LlmMessage, LlmPurpose, LlmResult } from './types.ts';

// OpenRouter LLM gateway (ADR-23). OpenAI-compatible chat-completions endpoint. Per-call cost is
// opted into with `usage: { include: true }` and read from `usage.cost` in the response — verified
// against OpenRouter docs 2026-08 (Context7 /websites/openrouter_ai). Model slugs live ONLY in this
// module (ADR-23); callers pass a purpose.

/** purpose -> model slug. The default string appears in exactly this one place in the repo (ADR-23). */
export const DEFAULT_MODELS: Readonly<Record<LlmPurpose, string>> = {
  hypothesize: 'google/gemini-2.5-flash-lite',
  report: 'google/gemini-2.5-flash-lite',
};

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// Bound the completion so OpenRouter doesn't default to the model's full context (tens of thousands
// of tokens), which fails a low-balance / credit-capped account with a 402. A hypothesis batch or a
// report fits comfortably; the app can raise it per purpose.
const DEFAULT_MAX_TOKENS = 4096;

export interface OpenRouterConfig {
  readonly apiKey: string;
  /** purpose -> slug override; merged over DEFAULT_MODELS. Lets the app pin a model via env (ADR-23). */
  readonly models?: Partial<Record<LlmPurpose, string>>;
  readonly baseUrl?: string;
  /** Max completion tokens per call (default 4096). Bounds spend and avoids the low-balance 402. */
  readonly maxTokens?: number;
  /** Optional OpenRouter attribution headers. */
  readonly referer?: string;
  readonly title?: string;
}

export interface OpenRouterDeps {
  /** Injectable for offline tests — defaults to global `fetch` (Node ≥24). */
  readonly fetchFn?: typeof fetch;
  readonly logger?: CorvidLogger;
}

// Only the response fields we read. Unknown keys are stripped (their API is additive), so a new
// OpenRouter field never breaks parsing.
const usageEnvelope = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  cost: z.number().optional(),
  is_byok: z.boolean().optional(),
});
const responseEnvelope = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })).min(1),
  usage: usageEnvelope.optional(),
});

function costFrom(usage: z.infer<typeof usageEnvelope> | undefined): LlmCost {
  if (usage === undefined) return ZERO_COST;
  return {
    costCredits: usage.cost ?? null,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    isByok: usage.is_byok ?? false,
  };
}

// Best-effort JSON-schema guidance for the model. The caller's Zod schema is the authority
// (buildResult re-validates), so `strict:false` here is fine and a model that ignores it still
// fails closed. If conversion is unsupported we simply omit the hint.
function responseFormat(schema: z.ZodType): unknown {
  try {
    const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' });
    return { type: 'json_schema', json_schema: { name: 'response', strict: false, schema: jsonSchema } };
  } catch {
    return undefined;
  }
}

export function createOpenRouterClient(config: OpenRouterConfig, deps: OpenRouterDeps = {}): LlmClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const models: Record<LlmPurpose, string> = { ...DEFAULT_MODELS, ...config.models };

  return {
    async complete<T>(
      purpose: LlmPurpose,
      messages: readonly LlmMessage[],
      schema: z.ZodType<T>,
    ): Promise<LlmResult<T>> {
      const model = models[purpose];

      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      };
      if (config.referer !== undefined) headers['HTTP-Referer'] = config.referer;
      if (config.title !== undefined) headers['X-Title'] = config.title;

      const body = {
        model,
        messages,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        usage: { include: true }, // opt in to per-call cost (ADR-21)
        response_format: responseFormat(schema),
      };

      let res: Response;
      try {
        res = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      } catch (cause) {
        throw new InfraError('llm gateway request failed', { retryable: true, cause });
      }

      if (!res.ok) {
        throw new InfraError('llm gateway returned an error status', {
          retryable: res.status === 429 || res.status >= 500,
          context: { status: res.status },
        });
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch (cause) {
        throw new InfraError('llm gateway returned non-JSON', { retryable: true, cause });
      }

      const envelope = responseEnvelope.safeParse(payload);
      if (!envelope.success) {
        throw new InfraError('llm gateway response shape unexpected', { retryable: true });
      }

      const cost = costFrom(envelope.data.usage);
      const resolvedModel = envelope.data.model ?? model;
      const content = envelope.data.choices[0]?.message.content;

      // Metadata only — never the prompt or the completion content (CODING_STANDARDS §5).
      deps.logger?.info(
        {
          purpose,
          model: resolvedModel,
          costCredits: cost.costCredits,
          totalTokens: cost.totalTokens,
          isByok: cost.isByok,
        },
        'llm completion received',
      );

      if (content === null || content === undefined || content.trim() === '') {
        return { ok: false, reason: 'invalid_output', cost, model: resolvedModel };
      }
      return buildResult(schema, content, cost, resolvedModel);
    },
  };
}
