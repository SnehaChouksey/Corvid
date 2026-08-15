import type { ReportFinding } from '@corvid/tool-contracts';
import * as z from 'zod';

import type { LlmMessage } from '@corvid/llm';

// The report narrative is the ONLY thing the LLM contributes (ADR-05). It writes an executive
// summary and per-finding remediation guidance over a finding list it is given and cannot change.
// The schema is strict so the model can't smuggle an extra field; remediations are keyed by the
// finding's index so a short/long/misordered array degrades gracefully (mapped by index, missing =
// no guidance) rather than corrupting the report.

export const reportNarrativeSchema = z
  .object({
    // Bounded: the summary is the most-read paragraph of a customer-facing artifact, so an over-long
    // or rambling completion fails validation (→ `ok:false` → the deterministic factualSummary), rather
    // than shipping unbounded LLM prose above the verified findings. The findings are authoritative.
    executiveSummary: z.string().min(1).max(1200),
    remediations: z.array(
      z.object({ index: z.number().int().nonnegative(), guidance: z.string().min(1) }).strict(),
    ),
  })
  .strict();
export type ReportNarrative = z.infer<typeof reportNarrativeSchema>;

const SYSTEM_PROMPT = [
  'You are a security report writer for an application-security tool.',
  'You are given a list of ALREADY-VERIFIED vulnerability findings — each was proven by a',
  'deterministic check, not opinion. Your job is to write an executive summary and concise,',
  'actionable remediation guidance for each finding.',
  'STRICT RULES:',
  '- Do NOT invent, add, remove, merge, or re-classify findings. Write only about the findings given.',
  '- Do NOT restate the proof as if uncertain — these are confirmed.',
  '- Do NOT include payloads or secrets verbatim beyond what is already in the finding descriptor.',
  '- Remediation must be specific to the vulnerability class and endpoint.',
  'Return JSON matching the requested schema exactly.',
].join(' ');

/** Build the messages for the report narrative. Only the safe finding facts are sent to the model. */
export function buildReportMessages(target: { url: string }, findings: readonly ReportFinding[]): LlmMessage[] {
  const items = findings.map((f, index) => ({
    index,
    vulnClass: f.vulnClass,
    endpoint: f.endpoint,
    payloadFamily: f.payload,
    proof: f.proof,
    severity: f.severity.raw ?? `${f.severity.band}`,
  }));
  const user = [
    `Target: ${target.url}`,
    `Verified findings (${findings.length}):`,
    JSON.stringify(items, null, 2),
    '',
    'Write an "executiveSummary" (2-4 sentences, factual, for a technical stakeholder) and a',
    '"remediations" array with one entry per finding index (fields: index, guidance).',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
