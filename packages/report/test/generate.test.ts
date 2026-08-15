import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { DailySpend, NewLlmCall, ScanReportData, SpendCeilings } from '@corvid/db';
import { createStubLlmClient, type LlmClient } from '@corvid/llm';

import { generateReport } from '../src/generate.ts';
import { renderReportHtml, renderReportJson } from '../src/render.ts';
import type { ReportContext } from '../src/types.ts';

const CEILINGS: SpendCeilings = { globalCeilingCredits: 100, userCeilingCredits: 100 };
const ZERO_SPEND: DailySpend = { globalSpentCredits: 0, userSpentCredits: 0 };

function ctx(
  overrides: Partial<ReportContext> & { data?: ScanReportData | undefined; llm?: LlmClient },
): { context: ReportContext; calls: NewLlmCall[]; llmInvocations: number } {
  const calls: NewLlmCall[] = [];
  let llmInvocations = 0;
  const llm =
    overrides.llm ??
    createStubLlmClient((purpose) => {
      llmInvocations += 1;
      assert.equal(purpose, 'report');
      return {
        content: {
          executiveSummary: 'One critical injection was confirmed.',
          remediations: [{ index: 0, guidance: 'Use parameterized queries.' }],
        },
        cost: { costCredits: 0.01, totalTokens: 100 },
      };
    });
  const context: ReportContext = {
    loadData: async () => overrides.data,
    llm,
    ceilings: overrides.ceilings ?? CEILINGS,
    now: overrides.now ?? (() => new Date('2026-08-16T00:00:00.000Z')),
    dailySpend: overrides.dailySpend ?? (async () => ZERO_SPEND),
    recordCall: async (c) => {
      calls.push(c);
    },
  };
  return {
    context,
    calls,
    get llmInvocations() {
      return llmInvocations;
    },
  };
}

const injectionFinding = {
  vulnClass: 'injection' as const,
  endpoint: 'POST https://app.example.com/api/search',
  payload: 'sql-error',
  proof: 'Dose-response time delay observed.',
  severity: '9.8 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  reportedAt: new Date('2026-08-16T00:00:00.000Z'),
};

test('a zero-finding scan produces an honest clean report with NO billed LLM call', async () => {
  const h = ctx({ data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [] } });
  const report = await generateReport(h.context, { scanId: 's1' });
  assert.equal(report.clean, true);
  assert.equal(report.findings.length, 0);
  assert.match(report.summary, /No verified vulnerabilities/);
  assert.equal(h.llmInvocations, 0); // clean report never bills
  assert.equal(h.calls.length, 0);
});

test('findings report: deterministic facts + LLM narrative/remediation applied by index', async () => {
  const idor = { ...injectionFinding, vulnClass: 'idor' as const, endpoint: 'GET /api/orders/42', severity: '6.5 CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N' };
  const h = ctx({ data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [idor, injectionFinding] } });
  const report = await generateReport(h.context, { scanId: 's1' });
  assert.equal(report.clean, false);
  // Sorted by severity: injection (9.8) before idor (6.5).
  assert.equal(report.findings[0]!.vulnClass, 'injection');
  assert.equal(report.findings[0]!.severity.band, 'critical');
  assert.equal(report.findings[0]!.remediation, 'Use parameterized queries.');
  assert.equal(report.findings[1]!.vulnClass, 'idor');
  assert.equal(report.summary, 'One critical injection was confirmed.');
  // Cost recorded at the call site (ADR-21).
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.purpose, 'report');
});

test('a spend stop degrades to a factual report (facts kept), never bills, never throws', async () => {
  const h = ctx({
    data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [injectionFinding] },
    dailySpend: async () => ({ globalSpentCredits: 999, userSpentCredits: 999 }),
  });
  const report = await generateReport(h.context, { scanId: 's1' });
  assert.equal(report.findings.length, 1); // verified facts still reported
  assert.equal(report.findings[0]!.remediation, null); // no narrative
  assert.match(report.summary, /verified/);
  assert.equal(h.llmInvocations, 0);
  assert.equal(h.calls.length, 0);
});

test('invalid LLM output still bills and still ships the factual report', async () => {
  const h = ctx({
    data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [injectionFinding] },
    llm: createStubLlmClient(() => ({ content: 'not json at all', cost: { costCredits: 0.02, totalTokens: 50 } })),
  });
  const report = await generateReport(h.context, { scanId: 's1' });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.remediation, null);
  assert.equal(h.calls.length, 1); // a garbage response still bills (ADR-21)
});

test('the report is verified-only: it can carry no hypothesis rationale (structural)', async () => {
  const h = ctx({ data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [injectionFinding] } });
  const report = await generateReport(h.context, { scanId: 's1' });
  // The report + its findings have no rationale key — the shape cannot express unverified reasoning.
  assert.equal('rationale' in report, false);
  for (const f of report.findings) assert.equal('rationale' in f, false);
});

test('renderReportJson round-trips; renderReportHtml escapes finding text', async () => {
  const xss = { ...injectionFinding, payload: '<script>alert(1)</script>', proof: 'a & b < c' };
  const h = ctx({ data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [xss] } });
  const report = await generateReport(h.context, { scanId: 's1' });

  const json = renderReportJson(report);
  assert.deepEqual(JSON.parse(json), report);

  const html = renderReportHtml(report);
  assert.equal(html.includes('<script>alert(1)</script>'), false); // escaped
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b &lt; c/);
});

test('renderReportHtml renders a clean report honestly', async () => {
  const h = ctx({ data: { scanId: 's1', ownerId: 'u1', targetUrl: 'https://app.example.com', findings: [] } });
  const report = await generateReport(h.context, { scanId: 's1' });
  const html = renderReportHtml(report);
  assert.match(html, /No verified vulnerabilities were found/);
});
