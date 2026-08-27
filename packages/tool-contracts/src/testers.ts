import * as z from 'zod';

import { httpMethodSchema, paramSchema } from './crawler.ts';

// The four tester tools (`02` §10, Unit 4). Each is called with only the scan + the hypothesis to
// test; the endpoint/method/param and the analyst-supplied credentials (D-1) are derived server-side
// from the hypothesis row + scan config — never from a tool argument, so a caller can't retarget or
// widen scope. Each tool emits exactly one OBSERVATION and NEVER decides "verified"/"vulnerable" —
// the verification gate does that (§8, ADR-01). A boolean verdict here would be a design error.

export const testerInputSchema = z
  .object({
    scanId: z.uuid(),
    hypothesisId: z.uuid(),
  })
  .strict();
export type TesterInput = z.infer<typeof testerInputSchema>;

/**
 * A compact, NON-SENSITIVE response signal: status + size + timing + a body hash. It carries enough
 * for the verifier's same/different comparison WITHOUT the raw body, so an observation is safe to
 * store and log (`CODING_STANDARDS.md` §5). The full raw body lives only transiently in the
 * `http.send` response the tester consumed.
 */
export const responseSignalSchema = z
  .object({
    status: z.number().int(),
    bodyLength: z.number().int().nonnegative(),
    timingMs: z.number().nonnegative(),
    /** sha-256 hex of the body — compared for material difference; NEVER the body itself. */
    bodyHash: z.string().min(1),
  })
  .readonly();
export type ResponseSignal = z.infer<typeof responseSignalSchema>;

// ---- jwt.mutate_test (verification signal D-13: none / valid / forged three-way) ----
export const jwtMutationKindSchema = z.enum(['alg_none', 'hs_rs_confusion', 'key_reuse']);
export type JwtMutationKind = z.infer<typeof jwtMutationKindSchema>;

export const jwtObservationSchema = z
  .object({
    vulnClass: z.literal('jwt'),
    /** The crawl-discovered endpoint used as the auth-state oracle. */
    oracleUrl: z.string().min(1),
    /** Baseline signals for the three-way comparison the verifier makes (D-13). */
    noToken: responseSignalSchema,
    validToken: responseSignalSchema,
    mutations: z.array(
      z
        .object({ kind: jwtMutationKindSchema, signal: responseSignalSchema })
        .readonly(),
    ),
  })
  .strict();
export type JwtObservation = z.infer<typeof jwtObservationSchema>;

// ---- injection.fuzz (SQLi error + time-based, NoSQLi — D-14) ----
export const injectionClassSchema = z.enum(['sqli_error', 'sqli_time', 'nosqli']);
export type InjectionClass = z.infer<typeof injectionClassSchema>;

export const injectionObservationSchema = z
  .object({
    vulnClass: z.literal('injection'),
    param: paramSchema,
    attempts: z.array(
      z
        .object({
          injectionClass: injectionClassSchema,
          payloadFamily: z.string().min(1),
          /** The un-injected request, for the diff/timing comparison the verifier makes. */
          baseline: responseSignalSchema,
          injected: responseSignalSchema,
          /** NAMES of matched DB-error patterns (never the raw error text) — observation, not verdict. */
          matchedErrorPatterns: z.array(z.string()),
        })
        .readonly(),
    ),
  })
  .strict();
export type InjectionObservation = z.infer<typeof injectionObservationSchema>;

// ---- ssrf.check (OOB-preferred — D-16; confirmation is out-of-band, Unit 5) ----
export const ssrfObservationSchema = z
  .object({
    vulnClass: z.literal('ssrf'),
    param: paramSchema,
    /** The unique token registered with the OOB listener; Unit 5 correlates an inbound callback. */
    oobToken: z.string().min(1),
    /** Whether the referencing payload was sent. Confirmation is out-of-band, never a socket signal. */
    sent: z.boolean(),
    /** Epoch ms the payload was sent — the verifier bounds a correlated callback to the D-4 window. */
    sentAt: z.number().int().nonnegative(),
  })
  .strict();
export type SsrfObservation = z.infer<typeof ssrfObservationSchema>;

// ---- idor.compare (labeled cross-session — D-15) ----
export const idorObservationSchema = z
  .object({
    vulnClass: z.literal('idor'),
    endpoint: z.string().min(1),
    method: httpMethodSchema,
    /** The same request issued under the two analyst-supplied sessions at different privilege (D-1). */
    lowPrivilege: responseSignalSchema,
    highPrivilege: responseSignalSchema,
    // Controls (D-15) — the low-privilege session against a resource it legitimately owns (must
    // succeed) and against a non-existent id (must fail). Without them, "A read this object" cannot
    // be told apart from A reading its own resource or a universal-200 endpoint. Optional on the wire
    // (older observations parse), but the verifier requires them to confirm.
    controlSelf: responseSignalSchema.optional(),
    controlAbsent: responseSignalSchema.optional(),
    // Access-control control: the SAME request with NO session (no auth headers). If it returns the
    // victim's object, the endpoint is simply public — not an IDOR — so the verifier refuses. Required
    // to confirm, so a public endpoint can never be reported as broken access control (zero-FP).
    controlUnauth: responseSignalSchema.optional(),
  })
  .strict();
export type IdorObservation = z.infer<typeof idorObservationSchema>;

/** A tester emits exactly one observation, discriminated by class. The gate decides (§8). */
export const testerObservationSchema = z.discriminatedUnion('vulnClass', [
  jwtObservationSchema,
  injectionObservationSchema,
  ssrfObservationSchema,
  idorObservationSchema,
]);
export type TesterObservation = z.infer<typeof testerObservationSchema>;
