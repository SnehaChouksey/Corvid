import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Command } from '@langchain/langgraph';

import {
  type ApprovalRequest,
  buildScanGraph,
  createCheckpointer,
  type ScanGraphDeps,
  type ScanStateType,
} from '../src/index.ts';

// Fake reasoning ops so the durability test exercises the durable spine only. `hypothesize` returns
// `generated`, so the graph proceeds through plan to the approval interrupt — the pause we resume.
const deps: ScanGraphDeps = {
  crawl: async () => ({
    endpoints: [],
    authFlows: [],
    stats: { pagesVisited: 0, endpointsFound: 0, skippedOutOfScope: 0 },
  }),
  hypothesize: async () => ({ kind: 'generated', inserted: [], deduped: 0 }),
  plan: async () => ({ planned: 0 }),
};

// The load-bearing DoD for the durable runtime (ADR-27): a scan pauses at the approval interrupt(),
// and a FRESH checkpointer (simulating a process restart) resumes the same thread from the Postgres
// checkpoint and runs to completion. Opt-in via DATABASE_URL (needs the docker Postgres up).

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL === undefined) {
  test('scan-runtime durability (skipped — set DATABASE_URL with a running Postgres)', { skip: true }, () => {});
} else {
  runIntegrationTest(DATABASE_URL);
}

function runIntegrationTest(databaseUrl: string): void {
  test('scan pauses at approval and resumes to completion across a checkpointer restart', async () => {
    const threadId = `scan-${Date.now()}`;
    const config = { configurable: { thread_id: threadId } };

    // --- process A: run until the approval interrupt, then "crash" (close the checkpointer). ---
    const a = await createCheckpointer(databaseUrl);
    try {
      const graph = buildScanGraph(a.checkpointer, deps);
      const paused = await graph.invoke(
        { scanId: threadId, userId: 'owner-1', status: 'authorizing' },
        config,
      );
      const interrupts = (paused as { __interrupt__?: ReadonlyArray<{ value: unknown }> }).__interrupt__;
      assert.ok(interrupts && interrupts.length === 1, 'expected one pending interrupt');
      assert.equal((interrupts[0]!.value as ApprovalRequest).kind, 'approval_request');
    } finally {
      await a.close();
    }

    // --- process B: fresh checkpointer + graph, same conn string. Resume the persisted pause. ---
    const b = await createCheckpointer(databaseUrl);
    try {
      const graph = buildScanGraph(b.checkpointer, deps);

      const snapshot = await graph.getState(config);
      assert.deepEqual(snapshot.next, ['awaitApproval']); // paused at the gate
      assert.equal((snapshot.values as ScanStateType).status, 'awaiting_approval');

      const done = await graph.invoke(new Command({ resume: { approvedHypotheses: ['h1'] } }), config);
      assert.equal(done.status, 'completed');
      assert.deepEqual(done.approvedHypotheses, ['h1']);
    } finally {
      await b.close();
    }
  });
}
