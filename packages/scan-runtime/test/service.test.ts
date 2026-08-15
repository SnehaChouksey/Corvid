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
  flush(): Promise<void>;
  recordApprovalArgs: { scanId: string; ownerId: string; approved: readonly string[] } | undefined;
}

function harness(opts: {
  approval?: ApprovalOutcome;
  cancel?: CancelOutcome;
  graph?: Partial<ScanGraphDeps>;
}): Harness {
  const statuses: ScanStatus[] = [];
  const tasks: Promise<void>[] = [];
  const h: Harness = {
    statuses,
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
