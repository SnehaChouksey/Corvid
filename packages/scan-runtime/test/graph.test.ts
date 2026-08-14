import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { HypothesizeInput, HypothesizeOutcome } from '@corvid/agent-core';
import type { CrawlerMapOutput, JwtObservation, ResponseSignal, SsrfObservation } from '@corvid/tool-contracts';
import { Command, MemorySaver } from '@langchain/langgraph';

import {
  buildScanGraph,
  type ObservedHypothesis,
  type ScanGraphDeps,
  type VerifiedFinding,
} from '../src/index.ts';

// Unit tests for the graph WIRING/ROUTING (the node logic itself lives in @corvid/agent-core and
// @corvid/verify). An in-memory checkpointer stands in for Postgres; fake reasoning + tester ops
// drive each branch.

const emptyMap: CrawlerMapOutput = {
  endpoints: [],
  authFlows: [],
  stats: { pagesVisited: 0, endpointsFound: 0, skippedOutOfScope: 0 },
};

function baseDeps(overrides: Partial<ScanGraphDeps>): ScanGraphDeps {
  return {
    crawl: async () => emptyMap,
    hypothesize: async () => ({ kind: 'generated', inserted: [], deduped: 0 }),
    plan: async () => ({ planned: 0 }),
    observe: async () => [],
    persistFinding: async () => {},
    oob: { wasCalledBack: async () => false },
    ...overrides,
  };
}

function depsWithOutcome(outcome: HypothesizeOutcome): ScanGraphDeps {
  return baseDeps({ hypothesize: async () => outcome });
}

function initial(scanId: string): { scanId: string; userId: string; status: 'authorizing' } {
  return { scanId, userId: 'u1', status: 'authorizing' };
}

const sig = (status: number, bodyHash: string): ResponseSignal => ({ status, bodyLength: 20, timingMs: 5, bodyHash });

function jwtObs(mutationMatchesValid: boolean): JwtObservation {
  const noToken = sig(401, 'anon');
  const validToken = sig(200, 'auth');
  return {
    vulnClass: 'jwt',
    oracleUrl: 'https://a.example.com/me',
    noToken,
    validToken,
    mutations: [{ kind: 'alg_none', signal: mutationMatchesValid ? validToken : noToken }],
  };
}

const ssrfObs = (sent: boolean): SsrfObservation => ({
  vulnClass: 'ssrf',
  param: { name: 'url', location: 'query' },
  oobToken: 'tok1',
  sent,
});

// ---- existing routing tests ----

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
  assert.equal((result as { status?: string }).status, 'stopped');
  const snap = await graph.getState(cfg);
  assert.deepEqual(snap.next, []);
});

test('a spend stop ends the run without reaching plan or approval', async () => {
  let planCalled = false;
  const graph = buildScanGraph(
    new MemorySaver(),
    baseDeps({
      hypothesize: async () => ({ kind: 'spend_stopped', scope: 'global' }),
      plan: async () => {
        planCalled = true;
        return { planned: 0 };
      },
    }),
  );
  const cfg = { configurable: { thread_id: 'spend' } };

  const result = await graph.invoke(initial('spend'), cfg);

  assert.equal((result as { __interrupt__?: readonly unknown[] }).__interrupt__, undefined);
  assert.equal(planCalled, false);
  assert.equal((result as { hypothesizeStatus?: string }).hypothesizeStatus, 'spend_stopped');
  assert.equal((result as { status?: string }).status, 'stopped');
});

test('the graph threads scanId/userId and the perceived surface into hypothesize', async () => {
  let seen: HypothesizeInput | undefined;
  const map: CrawlerMapOutput = {
    endpoints: [{ url: 'https://a.example.com/x', method: 'GET', source: 'xhr', params: [] }],
    authFlows: [],
    stats: { pagesVisited: 1, endpointsFound: 1, skippedOutOfScope: 0 },
  };
  const graph = buildScanGraph(
    new MemorySaver(),
    baseDeps({
      crawl: async () => map,
      hypothesize: async (input) => {
        seen = input;
        return { kind: 'generated', inserted: [], deduped: 0 };
      },
    }),
  );
  const cfg = { configurable: { thread_id: 'thread-data' } };

  await graph.invoke(initial('thread-data'), cfg);

  assert.equal(seen?.scanId, 'thread-data');
  assert.equal(seen?.userId, 'u1');
  assert.equal(seen?.surface.endpoints.length, 1);
});

// ---- act → observe → verify wiring (Unit 5) ----

test('the sync gate persists a verified finding and skips a not_confirmed observation', async () => {
  const persisted: VerifiedFinding[] = [];
  const observations: ObservedHypothesis[] = [
    { hypothesisId: 'h-verified', observation: jwtObs(true) },
    { hypothesisId: 'h-clean', observation: jwtObs(false) },
    { hypothesisId: 'h-notsent', observation: null },
  ];
  const graph = buildScanGraph(
    new MemorySaver(),
    baseDeps({
      observe: async () => observations,
      persistFinding: async (f) => {
        persisted.push(f);
      },
    }),
  );
  const cfg = { configurable: { thread_id: 'verify-sync' } };

  await graph.invoke(initial('verify-sync'), cfg);
  // Release the approval gate, approving all three hypotheses.
  const result = await graph.invoke(
    new Command({ resume: { approvedHypotheses: ['h-verified', 'h-clean', 'h-notsent'] } }),
    cfg,
  );

  assert.equal(persisted.length, 1, 'only the verified observation becomes a finding');
  assert.equal(persisted[0]?.hypothesisId, 'h-verified');
  assert.equal(persisted[0]?.vulnClass, 'jwt');
  assert.equal((result as { status?: string }).status, 'completed');
  assert.equal((result as { verifiedCount?: number }).verifiedCount, 1);
});

test('blind SSRF pauses at the OOB wait, then verifies on a correlated callback', async () => {
  const persisted: VerifiedFinding[] = [];
  const graph = buildScanGraph(
    new MemorySaver(),
    baseDeps({
      observe: async () => [{ hypothesisId: 'h-ssrf', observation: ssrfObs(true) }],
      persistFinding: async (f) => {
        persisted.push(f);
      },
      oob: { wasCalledBack: async () => true }, // the listener recorded a correlated callback
    }),
  );
  const cfg = { configurable: { thread_id: 'ssrf-hit' } };

  await graph.invoke(initial('ssrf-hit'), cfg);
  const paused = await graph.invoke(new Command({ resume: { approvedHypotheses: ['h-ssrf'] } }), cfg);

  // The graph is now waiting out of band — no finding yet, paused at awaitOob.
  assert.ok((paused as { __interrupt__?: readonly unknown[] }).__interrupt__, 'expected an OOB wait interrupt');
  const snap = await graph.getState(cfg);
  assert.deepEqual(snap.next, ['awaitOob']);
  assert.equal(persisted.length, 0);

  // The timeout sweep (D-4) releases the wait; the ledger is read and the callback confirms.
  const done = await graph.invoke(new Command({ resume: { timedOut: true } }), cfg);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.vulnClass, 'ssrf');
  assert.equal((done as { status?: string }).status, 'completed');
});

test('blind SSRF with no callback marks not confirmed at the wait — no finding', async () => {
  const persisted: VerifiedFinding[] = [];
  const graph = buildScanGraph(
    new MemorySaver(),
    baseDeps({
      observe: async () => [{ hypothesisId: 'h-ssrf', observation: ssrfObs(true) }],
      persistFinding: async (f) => {
        persisted.push(f);
      },
      oob: { wasCalledBack: async () => false }, // suppressed — no callback within the bound
    }),
  );
  const cfg = { configurable: { thread_id: 'ssrf-miss' } };

  await graph.invoke(initial('ssrf-miss'), cfg);
  await graph.invoke(new Command({ resume: { approvedHypotheses: ['h-ssrf'] } }), cfg);
  const done = await graph.invoke(new Command({ resume: { timedOut: true } }), cfg);

  assert.equal(persisted.length, 0, 'a suppressed callback is not confirmed — never a finding');
  assert.equal((done as { status?: string }).status, 'completed');
  assert.equal((done as { verifiedCount?: number }).verifiedCount, 0);
});
