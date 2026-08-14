import type { HypothesisStatus, ScanStatus, VulnClass } from '@corvid/tool-contracts';
import * as z from 'zod';

// Response-shape validation for every gateway DTO (CODING_STANDARDS §1: Zod at HTTP boundaries).
// The `satisfies` checks below pin each Zod enum to the shared domain union from
// `@corvid/tool-contracts` — a fifth vuln class or a new scan status becomes a compile error
// here, same guarantee `assertNever` gives the backend.

export const scanStatusSchema = z.enum([
  'authorizing',
  'crawling',
  'hypothesizing',
  'awaiting_approval',
  'testing',
  'reporting',
  'completed',
  'rejected',
  'cancelled',
  'stopped',
]);
scanStatusSchema satisfies z.ZodType<ScanStatus>;

export const hypothesisStatusSchema = z.enum(['pending', 'approved', 'rejected', 'tested', 'confirmed', 'not_confirmed']);
hypothesisStatusSchema satisfies z.ZodType<HypothesisStatus>;

export const vulnClassSchema = z.enum(['jwt', 'ssrf', 'injection', 'idor']);
vulnClassSchema satisfies z.ZodType<VulnClass>;

export const scopeRulesSchema = z.object({
  hosts: z.array(z.string().min(1)).min(1),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
});
export type ScopeRules = z.infer<typeof scopeRulesSchema>;

export const targetSummarySchema = z.object({
  id: z.string(),
  url: z.string(),
  scopeRules: scopeRulesSchema,
  authorized: z.boolean(),
  authorizationConfirmedAt: z.string().nullable(),
  authorizedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TargetSummary = z.infer<typeof targetSummarySchema>;

export const targetsListSchema = z.object({ targets: z.array(targetSummarySchema) });
export const createdIdSchema = z.object({ id: z.string() });

const challengeInstructionsSchema = z.object({
  host: z.string(),
  token: z.string(),
  dns: z.object({ recordType: z.literal('TXT'), name: z.string(), value: z.string() }),
  wellKnown: z.object({ url: z.string(), expectedContent: z.string() }),
});
export type ChallengeInstructions = z.infer<typeof challengeInstructionsSchema>;

export const authorizeResponseSchema = z.union([
  z.object({
    status: z.literal('pending'),
    instructions: challengeInstructionsSchema,
    reason: z.string().optional(),
  }),
  z.object({
    status: z.literal('authorized'),
    method: z.enum(['dns', 'well_known']).optional(),
    authorizationConfirmedAt: z.string().nullable(),
  }),
]);
export type AuthorizeResponse = z.infer<typeof authorizeResponseSchema>;

export const scanSummarySchema = z.object({
  id: z.string(),
  targetId: z.string(),
  status: scanStatusSchema,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ScanSummary = z.infer<typeof scanSummarySchema>;

export const scansListSchema = z.object({ scans: z.array(scanSummarySchema) });

const hypothesisPlanSchema = z
  .object({
    method: z.string(),
    param: z.object({ name: z.string(), location: z.string() }).optional(),
    payloadFamily: z.string(),
    tool: z.string().optional(),
    intendedPayload: z.string().optional(),
  })
  .nullable();

export const hypothesisSchema = z.object({
  id: z.string(),
  vulnClass: vulnClassSchema,
  endpoint: z.string(),
  rationale: z.string(),
  status: hypothesisStatusSchema,
  plan: hypothesisPlanSchema,
  createdAt: z.string(),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;
export type HypothesisPlan = z.infer<typeof hypothesisPlanSchema>;

export const hypothesesListSchema = z.object({ hypotheses: z.array(hypothesisSchema) });

export const findingSchema = z.object({
  id: z.string(),
  vulnClass: vulnClassSchema,
  payload: z.string(),
  proof: z.string(),
  severity: z.string().nullable(),
  reportedAt: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsListSchema = z.object({ findings: z.array(findingSchema) });

export const auditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actor: z.string(),
  detail: z.string().nullable(),
  timestamp: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListSchema = z.object({ audit: z.array(auditEntrySchema) });

export const approvalAcceptedSchema = z.object({
  status: z.literal('accepted'),
  approved: z.array(z.string()),
  rejected: z.array(z.string()),
});
export type ApprovalAccepted = z.infer<typeof approvalAcceptedSchema>;

export const cancelAcceptedSchema = z.object({ status: z.literal('cancelled') });
