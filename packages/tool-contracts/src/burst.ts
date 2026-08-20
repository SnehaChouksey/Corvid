import * as z from 'zod';

import { httpMethodSchema, paramSchema } from './crawler.ts';
import { scanCredentialsSchema } from './credentials.ts';
import type { VulnClass } from './domain.ts';
import { testerObservationSchema } from './testers.ts';

// The testing-burst wire contract (Unit 8 Phase 2). The gateway builds a BurstInput, ships it into an
// egress-restricted E2B sandbox with the bundled burst runner, and reads back a BurstOutput. Kept
// here (the shared package) so the gateway and the runner agree on one shape. Everything the runner
// needs travels in this payload — the sandbox has NO DB/Redis reachability (egress = target + OOB
// only), so scope/credentials/plans are all passed in, never looked up from inside.

/** The scope wire shape (mirrors @corvid/scope's ScopeRules; the runner re-validates with parseScopeRules). */
export const burstScopeSchema = z
  .object({
    hosts: z.array(z.string().min(1)).min(1),
    includePaths: z.array(z.string()).optional(),
    excludePaths: z.array(z.string()).optional(),
  })
  .readonly();

export const burstVulnClassSchema = z.enum(['jwt', 'ssrf', 'injection', 'idor']);
burstVulnClassSchema satisfies z.ZodType<VulnClass>;

/** One approved hypothesis to test, flattened from its row + plan (the runner rebuilds tester inputs). */
export const burstHypothesisSchema = z
  .object({
    hypothesisId: z.uuid(),
    vulnClass: burstVulnClassSchema,
    /** The endpoint under test (a full in-scope URL). */
    url: z.string().min(1),
    method: httpMethodSchema,
    /** The parameter to inject (injection/ssrf); absent for jwt/idor. */
    param: paramSchema.optional(),
    payloadFamily: z.string(),
    intendedPayload: z.string().optional(),
  })
  .strict();
export type BurstHypothesis = z.infer<typeof burstHypothesisSchema>;

export const burstInputSchema = z
  .object({
    scanId: z.uuid(),
    scope: burstScopeSchema,
    /** Decrypted analyst credentials (JWT sample / IDOR sessions); null when the scan supplied none. */
    credentials: scanCredentialsSchema.nullable(),
    /** OOB control-plane coordinates for SSRF token registration; absent → SSRF is skipped. */
    oob: z.object({ registerUrl: z.url(), controlToken: z.string().min(1) }).strict().optional(),
    hypotheses: z.array(burstHypothesisSchema),
  })
  .strict();
export type BurstInput = z.infer<typeof burstInputSchema>;

/** One hypothesis's observation (or null when the tester could not send — a clean not_confirmed). */
export const burstObservationSchema = z
  .object({
    hypothesisId: z.string(),
    observation: testerObservationSchema.nullable(),
  })
  .strict();

/** A collected http.send audit entry — written to the DB audit log by the gateway after the burst. */
export const burstAuditSchema = z
  .object({ scanId: z.string(), action: z.string(), detail: z.string().optional() })
  .strict();

/** A per-hypothesis tooling error — recorded (safe name only, §5) so an error is never read as a
 *  clean negative (§4); the hypothesis still gets a null observation (no finding, no false positive). */
export const burstErrorSchema = z.object({ hypothesisId: z.string(), error: z.string() }).strict();

export const burstOutputSchema = z
  .object({
    observations: z.array(burstObservationSchema),
    audits: z.array(burstAuditSchema),
    errors: z.array(burstErrorSchema),
  })
  .strict();
export type BurstOutput = z.infer<typeof burstOutputSchema>;
