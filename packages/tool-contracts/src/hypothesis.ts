import * as z from 'zod';

import { httpMethodSchema, paramSchema } from './crawler.ts';
import type { VulnClass } from './domain.ts';

// The `hypothesize` node's LLM-output contract (`02` §1, `03` Unit 3). The LLM proposes candidate
// vulns; this schema is the validation boundary between untrusted model output and everything
// downstream. A candidate that doesn't parse is a generation error that pauses the scan — the node
// never persists or acts on garbage (`01` §12). Author as `z.object({...}).strict()` (AGENTS.md):
// strict so the model cannot smuggle an unexpected field past validation.
//
// The LLM never sets a hypothesis's fingerprint or status — those are computed/assigned server-side
// (fingerprint is deterministic, see `fingerprint.ts`; status starts `pending`). The model only
// proposes what to test and why.

/** The four v1 vuln classes as a runtime schema. Kept in lockstep with `VulnClass` by the guard below. */
export const vulnClassSchema = z.enum(['jwt', 'ssrf', 'injection', 'idor']);

// Compile-time drift guard: if `VulnClass` (domain.ts) and `vulnClassSchema` ever diverge, one of
// these assignments stops type-checking. A fifth class must be added in both places at once.
type SchemaVulnClass = z.infer<typeof vulnClassSchema>;
const _vulnClassForward: SchemaVulnClass = 'jwt' as VulnClass;
const _vulnClassBackward: VulnClass = 'jwt' as SchemaVulnClass;
void _vulnClassForward;
void _vulnClassBackward;

/**
 * A single candidate vulnerability the LLM proposes. `url` + `method` name the in-scope endpoint
 * (drawn from the crawl map); `param` is where the test rides, when the class targets a parameter;
 * `payloadFamily` is the technique bucket (not an exact payload) that the `plan` node maps to a
 * concrete tester and that feeds the dedup fingerprint (ADR-D10). `rationale` is the human-readable
 * reasoning shown at the approval gate — it must let an analyst judge the candidate on its own.
 */
export const hypothesisCandidateSchema = z
  .object({
    vulnClass: vulnClassSchema,
    url: z.string().min(1),
    method: httpMethodSchema,
    param: paramSchema.optional(),
    payloadFamily: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();
export type HypothesisCandidate = z.infer<typeof hypothesisCandidateSchema>;

/** The full `hypothesize` LLM response: a batch of candidates (possibly empty on a small surface). */
export const hypothesisGenerationSchema = z
  .object({
    hypotheses: z.array(hypothesisCandidateSchema),
  })
  .strict();
export type HypothesisGeneration = z.infer<typeof hypothesisGenerationSchema>;

/**
 * The structured test plan persisted on a hypothesis (the `plan` jsonb column). At hypothesize time
 * it carries the fingerprint inputs that aren't their own columns (method, param, payload family);
 * the `plan` node and Unit 4/5 extend it additively (the concrete tool, payload, and the
 * human-readable intended payload shown at the approval gate — `02` §6). Validated where written
 * (agent core) and stored as a typed object in @corvid/db.
 */
export const hypothesisPlanSchema = z
  .object({
    method: httpMethodSchema,
    param: paramSchema.optional(),
    payloadFamily: z.string().min(1),
    // Added by the `plan` node (Unit 3): the selected tester (a `02` §10 tool name) and a
    // human-readable intended payload shown at the approval gate (`02` §6). The concrete payload
    // that gets sent lands in Unit 4 — this is the analyst-facing description, not a live payload.
    tool: z.string().min(1).optional(),
    intendedPayload: z.string().min(1).optional(),
  })
  .strict();
export type HypothesisPlan = z.infer<typeof hypothesisPlanSchema>;
