import * as z from 'zod';

import { httpMethodSchema } from './crawler.ts';

// The `http.send` shared request tool (`02` §10, ADR-24/ADR-25). EVERY tester's traffic flows
// through this one tool, which is where three safety properties are enforced in one place: path-level
// scope (the full URL is checked against the scan's recorded scope before sending — the E2B firewall
// only sees the host), the per-target rate posture (D-2), and per-scan dedup (so a replayed node's
// payload is not re-sent — ADR-27 idempotency). The scope is derived server-side from the scan's
// target row (like `crawler.map`), never from a tool argument — a caller can't widen scope.
//
// `http.send` returns an OBSERVATION (status/headers/body/timing). It never decides "verified" — the
// verification gate does (§8, ADR-01). A raw target body may ride on the response; it is returned to
// the verifier but MUST NEVER be logged (`CODING_STANDARDS.md` §5).

export const httpSendInputSchema = z
  .object({
    /** The scan whose recorded target scope + rate posture govern this request. */
    scanId: z.uuid(),
    method: httpMethodSchema,
    /** Full absolute URL. Checked against path-level scope before sending (ADR-24). */
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  })
  .strict();
export type HttpSendInput = z.infer<typeof httpSendInputSchema>;

/** The observed response — the raw signal the verifier reasons over. Never logged (§5). */
export const httpResponseSchema = z
  .object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
    /** Wall-clock time for the request, in milliseconds — the signal time-based checks read. */
    timingMs: z.number().nonnegative(),
  })
  .readonly();
export type HttpResponse = z.infer<typeof httpResponseSchema>;

/**
 * The outcome of an `http.send` call. `sent` carries the response. `refused_out_of_scope` is a
 * request whose full URL left the recorded scope — refused before any network I/O and audited like a
 * denied egress (ADR-24). `deduplicated` is a request already sent in this scan — not re-sent, so a
 * LangGraph replay is safe (ADR-27). A rate limit is NOT an outcome: `http.send` throttles/backs off
 * internally (D-2) and still returns `sent`.
 */
export const httpSendOutputSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('sent'), response: httpResponseSchema }).strict(),
  z.object({ outcome: z.literal('refused_out_of_scope') }).strict(),
  z.object({ outcome: z.literal('deduplicated') }).strict(),
]);
export type HttpSendOutput = z.infer<typeof httpSendOutputSchema>;
