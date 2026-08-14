// A Finding's `severity` is a CVSS 3.1 vector+score string (e.g. `"CVSS:3.1/AV:N/.../A:H 9.8"`).
// Corvid derives the display band from the numeric score per the standard CVSS 3.1 qualitative
// scale — the vector itself is shown verbatim elsewhere, never re-parsed for anything else.

export type SeverityBand = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface ParsedSeverity {
  readonly band: SeverityBand | 'unknown';
  readonly score: number | null;
}

export function parseSeverity(severity: string | null): ParsedSeverity {
  if (severity === null) {
    return { band: 'unknown', score: null };
  }
  const match = /(\d{1,2}(?:\.\d)?)/.exec(severity);
  const raw = match?.[1];
  if (raw === undefined) {
    return { band: 'unknown', score: null };
  }
  const score = Number.parseFloat(raw);
  if (Number.isNaN(score) || score < 0 || score > 10) {
    return { band: 'unknown', score: null };
  }
  return { band: bandForScore(score), score };
}

function bandForScore(score: number): SeverityBand {
  if (score === 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'medium';
  if (score < 9) return 'high';
  return 'critical';
}

export const SEVERITY_LABEL: Record<SeverityBand | 'unknown', string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
  unknown: 'Unrated',
};
