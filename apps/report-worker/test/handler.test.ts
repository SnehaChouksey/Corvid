import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { DailySpend, ScanReportData } from '@corvid/db';
import { createStubLlmClient } from '@corvid/llm';
import type { Report, ScanStatus } from '@corvid/tool-contracts';

import { buildReportHandler, type ReportWorkerDeps } from '../src/handler.ts';

const ZERO_SPEND: DailySpend = { globalSpentCredits: 0, userSpentCredits: 0 };

function harness(opts: {
  data: ScanReportData;
  renderPdf?: (html: string) => Promise<Buffer>;
  loadScanStatus?: () => Promise<ScanStatus | undefined>;
  loadExistingReport?: () => Promise<Report | undefined>;
  completeScan?: boolean;
}): {
  deps: ReportWorkerDeps;
  saved: { scanId: string; content: Report; pdf?: Buffer }[];
  completed: string[];
  audits: { scanId: string; action: string; detail?: string }[];
  order: string[];
} {
  const saved: { scanId: string; content: Report; pdf?: Buffer }[] = [];
  const completed: string[] = [];
  const audits: { scanId: string; action: string; detail?: string }[] = [];
  const order: string[] = [];

  const deps: ReportWorkerDeps = {
    reportCtx: {
      loadData: async () => opts.data,
      llm: createStubLlmClient(() => ({
        content: { executiveSummary: 'summary', remediations: [{ index: 0, guidance: 'fix it' }] },
        cost: { costCredits: 0.01, totalTokens: 10 },
      })),
      ceilings: { globalCeilingCredits: 100, userCeilingCredits: 100 },
      now: () => new Date('2026-08-16T00:00:00.000Z'),
      dailySpend: async () => ZERO_SPEND,
      recordCall: async () => undefined,
    },
    loadScanStatus: opts.loadScanStatus ?? (async () => 'reporting'),
    loadExistingReport: opts.loadExistingReport ?? (async () => undefined),
    renderPdf: opts.renderPdf ?? (async () => Buffer.from('%PDF-1.4 fake')),
    saveReport: async (input) => {
      order.push('save');
      saved.push(input);
    },
    completeScan: async (scanId) => {
      order.push('complete');
      const ok = opts.completeScan ?? true;
      if (ok) completed.push(scanId);
      return ok;
    },
    audit: async (entry) => {
      order.push('audit');
      audits.push(entry);
    },
  };
  return { deps, saved, completed, audits, order };
}

const finding = {
  vulnClass: 'injection' as const,
  endpoint: 'POST https://app.example.com/api/search',
  payload: 'sql-error',
  proof: 'Dose-response delay observed.',
  severity: '9.8 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  reportedAt: new Date('2026-08-16T00:00:00.000Z'),
};

const dataWithFinding: ScanReportData = {
  scanId: 's1',
  ownerId: 'u1',
  targetUrl: 'https://app.example.com',
  findings: [finding],
};

test('generates, stores report + PDF, then completes the scan and audits', async () => {
  const h = harness({ data: dataWithFinding });
  await buildReportHandler(h.deps)({ scanId: 's1' });

  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0]!.content.findings.length, 1);
  assert.ok(h.saved[0]!.pdf);
  assert.deepEqual(h.completed, ['s1']);
  assert.equal(h.audits[0]!.action, 'report.generated');
  assert.match(h.audits[0]!.detail!, /pdf=true/);
  // The report is stored BEFORE the scan is marked completed (completed = report exists).
  assert.ok(h.order.indexOf('save') < h.order.indexOf('complete'));
});

test('a PDF render failure degrades that export only — report still stored, scan still completed', async () => {
  const h = harness({
    data: dataWithFinding,
    renderPdf: async () => {
      throw new Error('chromium unavailable');
    },
  });
  await buildReportHandler(h.deps)({ scanId: 's1' });

  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0]!.pdf, undefined); // no PDF stored
  assert.deepEqual(h.completed, ['s1']); // but the scan still completes
  assert.match(h.audits[0]!.detail!, /pdf=false/); // degradation is on the record, not silent
});

test('a clean (zero-finding) scan produces a stored clean report and completes', async () => {
  const h = harness({ data: { ...dataWithFinding, findings: [] } });
  await buildReportHandler(h.deps)({ scanId: 's1' });

  assert.equal(h.saved[0]!.content.clean, true);
  assert.equal(h.saved[0]!.content.findings.length, 0);
  assert.deepEqual(h.completed, ['s1']);
});

test('a scan no longer in reporting (e.g. cancelled) is skipped — no report generated or stored', async () => {
  const h = harness({ data: dataWithFinding, loadScanStatus: async () => 'cancelled' });
  await buildReportHandler(h.deps)({ scanId: 's1' });

  assert.equal(h.saved.length, 0); // nothing generated or stored
  assert.deepEqual(h.completed, []);
  assert.equal(h.audits[0]!.action, 'report.superseded');
});

test('a scan cancelled mid-generation is not completed (guarded write returns false)', async () => {
  const h = harness({ data: dataWithFinding, completeScan: false });
  await buildReportHandler(h.deps)({ scanId: 's1' });

  assert.equal(h.saved.length, 1); // report was stored
  assert.deepEqual(h.completed, []); // but the scan was NOT flipped to completed
  assert.equal(h.audits.at(-1)!.action, 'report.superseded');
});
