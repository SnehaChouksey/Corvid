import type { LlmMessage } from '@corvid/llm';

import type { PerceivedSurface } from './types.ts';

// Prompt construction for the hypothesize LLM call. The surface is target-derived data — it is sent
// to the model (necessarily, to reason over) but MUST NEVER be logged (CODING_STANDARDS §5); the
// node logs only metadata. The model proposes candidates; the schema (response_format + Zod) is the
// contract for the shape, so this prompt focuses on grounding and the strict boundary.

const SYSTEM_PROMPT = [
  'You are Corvid, an application-security reasoning agent.',
  'From the given attack surface, propose candidate vulnerabilities to TEST. You never confirm a vulnerability — a separate deterministic checker does that; your job is only to hypothesize plausibly.',
  'Only these four classes are in scope: jwt, ssrf, injection, idor. Never propose anything else.',
  'For each candidate provide: the exact in-scope endpoint (url and method) taken verbatim from the surface, the parameter it targets if applicable, a short payload family (a technique bucket such as "sql-error" or "alg-none", never a literal payload), and a one-sentence rationale a human reviewer can evaluate.',
  'Do not invent endpoints or parameters that are not present in the surface. Prefer a few well-grounded candidates over many weak ones. An empty list is a valid answer when nothing is testable.',
  'Respond with JSON that matches the provided schema exactly.',
].join(' ');

export function buildHypothesizeMessages(surface: PerceivedSurface): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ surface }) },
  ];
}
