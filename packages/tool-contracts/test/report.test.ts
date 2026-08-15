import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  deriveSeverityBand,
  parseSeverity,
  reportJobSchema,
  reportSchema,
  type Report,
} from '../src/index.ts';

test('deriveSeverityBand follows the CVSS 3.1 qualitative scale boundaries', () => {
  assert.equal(deriveSeverityBand(0), 'none');
  assert.equal(deriveSeverityBand(0.1), 'low');
  assert.equal(deriveSeverityBand(3.9), 'low');
  assert.equal(deriveSeverityBand(4.0), 'medium');
  assert.equal(deriveSeverityBand(6.9), 'medium');
  assert.equal(deriveSeverityBand(7.0), 'high');
  assert.equal(deriveSeverityBand(8.9), 'high');
  assert.equal(deriveSeverityBand(9.0), 'critical');
  assert.equal(deriveSeverityBand(10), 'critical');
});

test('parseSeverity extracts score + vector without misreading the CVSS version token', () => {
  const s = parseSeverity('9.8 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
  assert.equal(s.score, 9.8); // not 3.1 from the version
  assert.equal(s.vector, 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
  assert.equal(s.band, 'critical');
});

test('parseSeverity tolerates score-last ordering', () => {
  const s = parseSeverity('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N 8.1');
  assert.equal(s.score, 8.1);
  assert.equal(s.band, 'high');
});

test('parseSeverity floors to a none band on a null/unparseable severity (never invents a score)', () => {
  assert.deepEqual(parseSeverity(null), { score: null, vector: null, band: 'none' });
  const s = parseSeverity('unknown');
  assert.equal(s.score, null);
  assert.equal(s.band, 'none');
});

test('reportSchema accepts a clean (zero-finding) report', () => {
  const clean: Report = {
    scanId: 'scan-1',
    generatedAt: '2026-08-16T00:00:00.000Z',
    target: { url: 'https://app.example.com' },
    summary: 'No verified vulnerabilities were found.',
    clean: true,
    findings: [],
  };
  assert.equal(reportSchema.safeParse(clean).success, true);
});

test('reportSchema rejects an unknown top-level key (no smuggled reasoning field)', () => {
  const bad = {
    scanId: 'scan-1',
    generatedAt: '2026-08-16T00:00:00.000Z',
    target: { url: 'https://app.example.com' },
    summary: 's',
    clean: true,
    findings: [],
    rationale: 'raw agent reasoning', // must be rejected by .strict()
  };
  assert.equal(reportSchema.safeParse(bad).success, false);
});

test('reportJobSchema requires a uuid scanId', () => {
  assert.equal(reportJobSchema.safeParse({ scanId: '550e8400-e29b-41d4-a716-446655440000' }).success, true);
  assert.equal(reportJobSchema.safeParse({ scanId: 'not-a-uuid' }).success, false);
});
