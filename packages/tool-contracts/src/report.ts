import * as z from 'zod';

import { vulnClassSchema } from './hypothesis.ts';

// The verified-only report contract (ADR-05, ADR-26, D-3). This is the shape the Report Writer
// (`@corvid/report`) produces, the fan-out worker persists, and the gateway serves in three forms
// (dashboard view / JSON export / PDF export) — all from the one verified-findings source. It carries
// deterministic finding FACTS (class, endpoint, payload, proof, CVSS severity — never re-derived by
// an LLM) plus an LLM-written narrative layer (executive summary + per-finding remediation) that can
// only ANNOTATE the fixed finding list, never add or remove a finding. There is no field here for a
// hypothesis's raw rationale/plan — the report structurally cannot carry unverified reasoning.

/** CVSS 3.1 qualitative band, derived from the numeric base score — stored, not re-parsed downstream. */
export type SeverityBand = 'critical' | 'high' | 'medium' | 'low' | 'none';

export const severityBandSchema = z.enum(['critical', 'high', 'medium', 'low', 'none']);

/**
 * Map a CVSS 3.1 base score to its qualitative band (the standard 3.1 scale, `ADR-D3`):
 * None 0.0 · Low 0.1–3.9 · Medium 4.0–6.9 · High 7.0–8.9 · Critical 9.0–10.0.
 */
export function deriveSeverityBand(score: number): SeverityBand {
  if (score <= 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'medium';
  if (score < 9) return 'high';
  return 'critical';
}

export interface ParsedSeverity {
  /** The CVSS 3.1 numeric base score, or null if the stored string had none. */
  readonly score: number | null;
  /** The CVSS 3.1 vector string (`CVSS:3.1/AV:N/...`), or null if not present. */
  readonly vector: string | null;
  /** Band derived from the score; `none` when there is no parseable score (an honest floor). */
  readonly band: SeverityBand;
}

/**
 * Parse a finding's stored `severity` string into a score + vector + band. The stored form is a CVSS
 * 3.1 base score and its vector (e.g. `"9.8 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"`); order
 * is tolerated. A null/unparseable severity yields a `none`-band result — the report never invents a
 * score it doesn't have.
 */
export function parseSeverity(severity: string | null): ParsedSeverity {
  if (severity === null) return { score: null, vector: null, band: 'none' };
  const vectorMatch = /CVSS:3\.1\/[A-Z:/.]+/.exec(severity);
  const vector = vectorMatch?.[0] ?? null;
  // The score is the numeric token that is NOT part of the vector (strip the vector first so a
  // metric like `3.1` in `CVSS:3.1` can't be misread as the score).
  const withoutVector = vector === null ? severity : severity.replace(vector, '');
  const scoreMatch = /(\d{1,2}(?:\.\d)?)/.exec(withoutVector);
  const raw = scoreMatch?.[1];
  const score = raw === undefined ? null : Number.parseFloat(raw);
  if (score === null || Number.isNaN(score) || score < 0 || score > 10) {
    return { score: null, vector, band: 'none' };
  }
  return { score, vector, band: deriveSeverityBand(score) };
}

export const reportSeveritySchema = z
  .object({
    score: z.number().min(0).max(10).nullable(),
    vector: z.string().nullable(),
    band: severityBandSchema,
    /** The raw stored severity string, kept verbatim for the PDF/JSON so nothing is lost in parsing. */
    raw: z.string().nullable(),
  })
  .readonly();
export type ReportSeverity = z.infer<typeof reportSeveritySchema>;

export const reportFindingSchema = z
  .object({
    vulnClass: vulnClassSchema,
    /** The in-scope endpoint the finding is at (from the hypothesis — its endpoint only, no rationale). */
    endpoint: z.string(),
    /** Safe technique/payload-family descriptor (never a raw body/secret, §5). */
    payload: z.string(),
    /** The deterministic proof the verification gate produced (why the exploit provably fired). */
    proof: z.string(),
    severity: reportSeveritySchema,
    /** LLM-written remediation guidance for this finding, or null when unavailable (spend stop / no LLM). */
    remediation: z.string().nullable(),
    /** ISO-8601 timestamp the finding was verified/recorded. */
    reportedAt: z.string(),
  })
  .strict();
export type ReportFinding = z.infer<typeof reportFindingSchema>;

export const reportSchema = z
  .object({
    scanId: z.string(),
    /** ISO-8601 generation timestamp. */
    generatedAt: z.string(),
    target: z.object({ url: z.string() }).strict(),
    /**
     * The executive summary. LLM-written when there are findings and spend allows; a deterministic
     * honest statement for a clean (zero-finding) report or when the LLM path is unavailable.
     */
    summary: z.string(),
    /** True when no verified findings exist — an honest clean report, never padded with maybes. */
    clean: z.boolean(),
    /** Findings sorted by severity (highest first); verified-only by construction. */
    findings: z.array(reportFindingSchema),
  })
  .strict();
export type Report = z.infer<typeof reportSchema>;

/**
 * The durable BullMQ `report.generate` job payload (ADR-17). Enqueued (jobId `report-<scanId>`,
 * idempotent) when a scan enters `reporting`; the report-worker consumes it, generates + stores the
 * report, and completes the scan. Nothing sensitive rides here — the worker reads the scan by id.
 */
export const reportJobSchema = z.object({ scanId: z.uuid() }).strict();
export type ReportJob = z.infer<typeof reportJobSchema>;
