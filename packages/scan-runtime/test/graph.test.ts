import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { HypothesizeInput, HypothesizeOutcome } from '@corvid/agent-core';
import type { CrawlerMapOutput } from '@corvid/tool-contracts';
import { MemorySaver } from '@langchain/langgraph';

import { buildScanGraph, type ScanGraphDeps } from '../src/index.ts';

// Unit tests for the graph WIRING/ROUTING (the node logic itself lives in @corvid/agent-core). An
// in-memory checkpointer stands in for Postgres; fake reasoning ops drive each branch.

const emptyMap: CrawlerMapOutput = {
  endpoints: [],
  authFlows: [],
  stats: { pagesVisited: 0, endpointsFound: 0, skippedOutOfScope: 0 },
};

function depsWithOutcome(outcome: HypothesizeOutcome): ScanGraphDeps {
  return {
    crawl: async () => emptyMap,
    hypothesize: async () => outcome,
    plan: async () => ({ planned: 0 }),
  };
}

function initial(scanId: string): { scanId: string; userId: string; status: 'authorizing' } {
  return { scanId, userId: 'u1', status: 'authorizing' };
}

test('a successful generation runs through to the approval interrupt', async () => {
  const graph = buildScanGraph(new MemorySaver(), depsWithOutcome({ kind: 'generated', inserted: [], deduped: 0 }));
  const cfg = { configurable: { thread_id: 'gen' } };

  const result = await graph.invoke(initial('gen'), cfg);

  const interrupts = (result as { __interrupt__?: readonly unknown[] }).__interrupt__;
  assert.ok(interrupts && interrupts.length === 1, 'expected one pending approval interrupt');
  const snap = await graph.getState(cfg);
  assert.deepEqual(snap.next, ['awaitApproval']);
  assert.equal((snap.values as { status: string }).status, 'awaiting_approval');
});

test('a generation error ends the run without an approval gate', async () => {
  const graph = buildScanGraph(new MemorySaver(), depsWithOutcome({ kind: 'generation_error' }));
  const cfg = { configurable: { thread_id: 'err' } };

  const result = await graph.invoke(initial('err'), cfg);

  assert.equal((result as { __interrupt__?: readonly unknown[] }).__interrupt__, undefined);
  assert.equal((result as { hypothesizeStatus?: string }).hypothesizeStatus, 'generation_error');
  const snap = await graph.getState(cfg);
  assert.deepEqual(snap.next, []); // finished — no pending node
});

test('a spend stop ends the run without reaching plan or approval', async () => {
  let planCalled = false;
  const graph = buildScanGraph(new MemorySaver(), {
    crawl: async () => emptyMap,
    hypothesize: async () => ({ kind: 'spend_stopped', scope: 'global' }),
    plan: async () => {
      planCalled = true;
      return { planned: 0 };
    },
  });
  const cfg = { configurable: { thread_id: 'spend' } };

  const result = await graph.invoke(initial('spend'), cfg);

  assert.equal((result as { __interrupt__?: readonly unknown[] }).__interrupt__, undefined);
  assert.equal(planCalled, false);
  assert.equal((result as { hypothesizeStatus?: string }).hypothesizeStatus, 'spend_stopped');
});

test('the graph threads scanId/userId and the perceived surface into hypothesize', async () => {
  let seen: HypothesizeInput | undefined;
  const map: CrawlerMapOutput = {
    endpoints: [{ url: 'https://a.example.com/x', method: 'GET', source: 'xhr', params: [] }],
    authFlows: [],
    stats: { pagesVisited: 1, endpointsFound: 1, skippedOutOfScope: 0 },
  };
  const graph = buildScanGraph(new MemorySaver(), {
    crawl: async () => map,
    hypothesize: async (input) => {
      seen = input;
      return { kind: 'generated', inserted: [], deduped: 0 };
    },
    plan: async () => ({ planned: 0 }),
  });
  const cfg = { configurable: { thread_id: 'thread-data' } };

  await graph.invoke(initial('thread-data'), cfg);

  assert.equal(seen?.scanId, 'thread-data');
  assert.equal(seen?.userId, 'u1');
  assert.equal(seen?.surface.endpoints.length, 1); // perceive ran and produced the surface
});
