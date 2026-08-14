import * as z from 'zod';

// Analyst-supplied target credentials, captured at scan config (D-1, ADR-D1; `01` §4, `02` §10).
// Corvid never provisions accounts on the target — it uses what the analyst provides. Every field is
// OPTIONAL: a scan with none simply tests the unauthenticated surface (`01` §4). Stored ENCRYPTED at
// rest, scoped to the scan, decrypted only transiently at use (`02` §7) — these are secrets and must
// never be logged (§5). This is a shared schema (the dashboard produces it; the crawler and testers
// consume it), so it lives in tool-contracts, the load-bearing shared package (CODING_STANDARDS §2).

/** One authenticated session at a known privilege level, for `idor.compare` (D-15 labeled). */
export const sessionCredentialSchema = z
  .object({
    // A human label for the privilege level (e.g. "admin", "user-a") — surfaced in the IDOR proof.
    label: z.string().min(1),
    // The auth material replayed for this session (e.g. { Cookie } or { Authorization }).
    headers: z.record(z.string().min(1), z.string()),
  })
  .strict();
export type SessionCredential = z.infer<typeof sessionCredentialSchema>;

export const scanCredentialsSchema = z
  .object({
    // (a) A login the crawler replays to map the authenticated surface.
    crawlLogin: z
      .object({ loginUrl: z.url(), username: z.string().min(1), password: z.string().min(1) })
      .strict()
      .optional(),
    // (b) A sample JWT for `jwt.mutate_test` (alg:none / key-confusion / key-reuse forgeries).
    jwtSample: z.string().min(1).optional(),
    // (c) Two sessions at different privilege for `idor.compare` (D-15).
    idorSessions: z
      .object({ primary: sessionCredentialSchema, secondary: sessionCredentialSchema })
      .strict()
      .optional(),
  })
  .strict();
export type ScanCredentials = z.infer<typeof scanCredentialsSchema>;
