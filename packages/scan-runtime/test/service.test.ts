import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { ApprovalOutcome, CancelOutcome, CrawlerMapOutput, ScanStatus } from '@corvid/tool-contracts';
import { MemorySaver } from '@langchain/langgraph';

import { buildScanGraph, createScanRuntimeService, type ScanGraphDeps } from '../src/index.ts';

// Unit tests for the gateway↔runtime service. A MemorySaver graph with fake reasoning/tester ops
// stands in for the durable Postgres graph; the DB ports are fakes. The `background` port collects
// scheduled work so a test can await the fire-and-forget graph runs deterministically.

const emptyMap: CrawlerMapOutput = {
  endpoints: [],
  authFlows: [],
  stats: { pagesVisited: 0, endpointsFound: 0, skippedOutOfScope: 0 },
};

function graphDeps(overrides: Partial<ScanGraphDeps> = {}): ScanGraphDeps {
  return {
    crawl: async () => emptyMap,
    hypothesize: async () => ({ kind: 'generated', inserted: [], deduped: 0 }),
    plan: async () => ({ planned: 0 }),
    observe: async () => [],
    persistFinding: async () => {},
    oob: { getCallback: async () => null },
    ...overrides,
  };
}

interface Harness {
  readonly service: ReturnType<typeof createScanRuntimeService>;
  readonly statuses: ScanStatus[];
  readonly oobWaits: string[];
  flush(): Promise<void>;
  recordApprovalArgs: { scanId: string; ownerId: string; approved: readonly string[] } | undefined;
}

// A blind-SSRF observation: the graph routes it to the durable `awaitOob` wait (never a synchronous
// verdict), so a scan that sees one pauses — the case the OOB sweep exists to resolve.
const ssrfObserved = {
  hypothesisId: 'h1',
  observation: {
    vulnClass: 'ssrf' as const,
    param: { name: 'url', location: 'query' as const },
    oobToken: 'a'.repeat(32),
    sent: true,
    sentAt: 1,
  },
};

function harness(opts: {
  approval?: ApprovalOutcome;
  cancel?: CancelOutcome;
  graph?: Partial<ScanGraphDeps>;
}): Harness {
  const statuses: ScanStatus[] = [];
  const oobWaits: string[] = [];
  const tasks: Promise<void>[] = [];
  const h: Harness = {
    statuses,
    oobWaits,
    recordApprovalArgs: undefined,
    async flush() {
      await Promise.all(tasks);
    },
    service: createScanRuntimeService({
      graph: buildScanGraph(new MemorySaver(), graphDeps(opts.graph)),
      persistStatus: async (_scanId, status) => {
        statuses.push(status);
      },
      recordApproval: async (scanId, ownerId, approved) => {
        h.recordApprovalArgs = { scanId, ownerId, approved };
        return opts.approval ?? { kind: 'not_awaiting' };
      },
      requestCancel: async () => opts.cancel ?? 'cancelled',
      background: (task) => {
        tasks.push(task());
      },
      onOobWait: async (scanId) => {
        oobWaits.push(scanId);
      },
    }),
  };
  return h;
}

test('start drives the graph to the approval gate and syncs awaiting_approval', async () => {
  const h = harness({});
  h.service.start('scan-1', 'user-1');
  await h.flush();
  assert.deepEqual(h.statuses, ['awaiting_approval']);
});

test('submitApproval records the decision then resumes to completion', async () => {
  const h = harness({ approval: { kind: 'accepted', approved: ['h1'], rejected: ['h2'] } });
  h.service.start('scan-2', 'user-1');
  await h.flush();
  assert.deepEqual(h.statuses, ['awaiting_approval']);

  const outcome = await h.service.submitApproval('scan-2', 'user-1', { approvedHypotheses: ['h1'] });
  await h.flush();

  assert.deepEqual(outcome, { kind: 'accepted', approved: ['h1'], rejected: ['h2'] });
  assert.deepEqual(h.recordApprovalArgs, { scanId: 'scan-2', ownerId: 'user-1', approved: ['h1'] });
  assert.equal(h.statuses.at(-1), 'reporting'); // resumed test→verify→report (completion is the report worker, ADR-34)
});

test('submitApproval does NOT resume when the decision is not accepted', async () => {
  let resumed = false;
  const h = harness({
    approval: { kind: 'not_awaiting' },
    graph: {
      observe: async () => {
        resumed = true; // observe only runs if the graph was resumed past the gate
        return [];
      },
    },
  });
  h.service.start('scan-3', 'user-1');
  await h.flush();

  const outcome = await h.service.submitApproval('scan-3', 'user-1', { approvedHypotheses: ['h1'] });
  await h.flush();

  assert.deepEqual(outcome, { kind: 'not_awaiting' });
  assert.equal(resumed, false); // never resumed → no test node ran (invariant #1)
});

test('submitApproval surfaces invalid_hypotheses without resuming', async () => {
  const h = harness({ approval: { kind: 'invalid_hypotheses', unknown: ['bogus'] } });
  h.service.start('scan-4', 'user-1');
  await h.flush();

  const outcome = await h.service.submitApproval('scan-4', 'user-1', { approvedHypotheses: ['bogus'] });
  await h.flush();

  assert.deepEqual(outcome, { kind: 'invalid_hypotheses', unknown: ['bogus'] });
});

test('cancel delegates to the injected port', async () => {
  const h = harness({ cancel: 'not_cancellable' });
  assert.equal(await h.service.cancel('scan-5', 'user-1'), 'not_cancellable');
});

test('a blind-SSRF observation pauses at awaitOob, registers via onOobWait, and does not yet report', async () => {
  const h = harness({
    approval: { kind: 'accepted', approved: ['h1'], rejected: [] },
    graph: { observe: async () => [ssrfObserved] },
  });
  h.service.start('scan-oob', 'user-1');
  await h.flush();

  await h.service.submitApproval('scan-oob', 'user-1', { approvedHypotheses: ['h1'] });
  await h.flush();

  // Paused at the durable OOB wait: registered for the sweep, and NOT yet at reporting (the wait is
  // still open — only the sweep's timeout resume finalizes it).
  assert.deepEqual(h.oobWaits, ['scan-oob']);
  assert.equal(h.statuses.includes('reporting'), false);
});

test('resumeOobWait resolves a paused OOB wait to reporting, and is a no-op otherwise (idempotent)', async () => {
  const h = harness({
    approval: { kind: 'accepted', approved: ['h1'], rejected: [] },
    graph: { observe: async () => [ssrfObserved] },
  });
  h.service.start('scan-oob2', 'user-1');
  await h.flush();
  await h.service.submitApproval('scan-oob2', 'user-1', { approvedHypotheses: ['h1'] });
  await h.flush();
  assert.equal(h.statuses.includes('reporting'), false);

  // The sweep's timeout resume drives the graph through the OOB verdict (getCallback → null → not
  // confirmed) to reporting.
  await h.service.resumeOobWait('scan-oob2');
  assert.equal(h.statuses.at(-1), 'reporting');

  // Idempotent: a second resume (e.g. a duplicate sweep tick) finds the thread no longer paused and
  // makes no further status transition.
  const before = h.statuses.length;
  await h.service.resumeOobWait('scan-oob2');
  assert.equal(h.statuses.length, before);

  // A scan that was never at an OOB wait is a plain no-op too.
  await h.service.resumeOobWait('never-started');
});
