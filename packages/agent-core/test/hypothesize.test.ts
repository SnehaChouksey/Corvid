import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { DailySpend, HypothesisRow, NewHypothesis, NewLlmCall, SpendCeilings } from '@corvid/db';
import { createStubLlmClient, type LlmClient, type StubReply } from '@corvid/llm';

import { hypothesize, type HypothesizeContext, type PerceivedSurface } from '../src/index.ts';

const surface: PerceivedSurface = {
  endpoints: [
    {
      url: 'https://app.example.com/api/orders/1',
      method: 'GET',
      source: 'xhr',
      params: [{ name: 'id', location: 'path' }],
    },
  ],
  authFlows: [],
  stats: { endpointCount: 1, parameterizedCount: 1, authFlowCount: 0 },
};

const ceilings: SpendCeilings = { globalCeilingCredits: 5, userCeilingCredits: 1 };

const validReply: StubReply = {
  content: {
    hypotheses: [
      {
        vulnClass: 'idor',
        url: 'https://app.example.com/api/orders/1',
        method: 'GET',
        param: { name: 'id', location: 'path' },
        payloadFamily: 'cross-session-read',
        rationale: 'Sequential order id under an authenticated session.',
      },
    ],
  },
  cost: { costCredits: 0.001, totalTokens: 20 },
};

interface Recorded {
  calls: NewLlmCall[];
  markedSeen: string[][];
}

function toRow(r: NewHypothesis, i: number): HypothesisRow {
  return {
    id: `h-${i}-${r.fingerprint.slice(0, 6)}`,
    scanId: r.scanId,
    vulnClass: r.vulnClass,
    endpoint: r.endpoint,
    rationale: r.rationale,
    fingerprint: r.fingerprint,
    status: 'pending',
    plan: r.plan ?? null,
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
  };
}

function makeContext(opts: { llm: LlmClient; spent?: DailySpend }): { ctx: HypothesizeContext; rec: Recorded } {
  const rec: Recorded = { calls: [], markedSeen: [] };
  // Shared across persist calls on this ctx: simulates the DB unique (scan_id, fingerprint).
  const seen = new Set<string>();
  const ctx: HypothesizeContext = {
    llm: opts.llm,
    ceilings,
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    dailySpend: async () => opts.spent ?? { globalSpentCredits: 0, userSpentCredits: 0 },
    recordCall: async (call) => {
      rec.calls.push(call);
    },
    persist: async (rows) => {
      const inserted: HypothesisRow[] = [];
      rows.forEach((r, i) => {
        if (seen.has(r.fingerprint)) return;
        seen.add(r.fingerprint);
        inserted.push(toRow(r, i));
      });
      return inserted;
    },
    markSeen: async (_scanId, fingerprints) => {
      rec.markedSeen.push([...fingerprints]);
    },
  };
  return { ctx, rec };
}

test('generates and persists hypotheses, records cost, and warms the dedup cache', async () => {
  const llm = createStubLlmClient(() => validReply);
  const { ctx, rec } = makeContext({ llm });

  const outcome = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });

  assert.equal(outcome.kind, 'generated');
  if (outcome.kind === 'generated') {
    assert.equal(outcome.inserted.length, 1);
    assert.equal(outcome.deduped, 0);
    assert.equal(outcome.inserted[0]?.plan?.payloadFamily, 'cross-session-read');
  }
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]?.purpose, 'hypothesize');
  assert.equal(rec.calls[0]?.costCredits, 0.001);
  assert.equal(rec.markedSeen[0]?.length, 1);
});

test('re-running on the same surface dedups; cost is recorded every run', async () => {
  const llm = createStubLlmClient(() => validReply);
  const { ctx, rec } = makeContext({ llm });

  const first = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });
  const second = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });

  if (first.kind === 'generated') assert.equal(first.inserted.length, 1);
  assert.equal(second.kind, 'generated');
  if (second.kind === 'generated') {
    assert.equal(second.inserted.length, 0);
    assert.equal(second.deduped, 1);
  }
  assert.equal(rec.calls.length, 2);
});

test('duplicate candidates within one batch collapse to a single hypothesis', async () => {
  const base = {
    vulnClass: 'jwt' as const,
    url: 'https://app.example.com/api/me',
    method: 'GET' as const,
    payloadFamily: 'alg-none',
    rationale: 'JWT accepted at this endpoint.',
  };
  const llm = createStubLlmClient(() => ({ content: { hypotheses: [base, { ...base, rationale: 'variant' }] } }));
  const { ctx } = makeContext({ llm });

  const outcome = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });
  assert.equal(outcome.kind, 'generated');
  if (outcome.kind === 'generated') {
    assert.equal(outcome.inserted.length, 1);
    assert.equal(outcome.deduped, 1);
  }
});

test('refuses with spend_stopped when the daily cap is reached, without calling the LLM', async () => {
  let llmCalled = false;
  const llm = createStubLlmClient(() => {
    llmCalled = true;
    return validReply;
  });
  const { ctx, rec } = makeContext({ llm, spent: { globalSpentCredits: 10, userSpentCredits: 0 } });

  const outcome = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });

  assert.equal(outcome.kind, 'spend_stopped');
  if (outcome.kind === 'spend_stopped') assert.equal(outcome.scope, 'global');
  assert.equal(llmCalled, false);
  assert.equal(rec.calls.length, 0);
});

test('invalid LLM output pauses the scan (generation_error) but still records cost', async () => {
  const llm = createStubLlmClient(() => ({ content: 'not valid json', cost: { costCredits: 0.002, totalTokens: 5 } }));
  const { ctx, rec } = makeContext({ llm });

  const outcome = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });

  assert.equal(outcome.kind, 'generation_error');
  assert.equal(rec.calls.length, 1); // recorded before the parse verdict
  assert.equal(rec.calls[0]?.costCredits, 0.002);
});

test('an empty hypotheses list from VALID output is a normal generated result, not an error', async () => {
  const llm = createStubLlmClient(() => ({ content: { hypotheses: [] } }));
  const { ctx } = makeContext({ llm });

  const outcome = await hypothesize(ctx, { scanId: 's1', userId: 'u1', surface });
  assert.equal(outcome.kind, 'generated');
  if (outcome.kind === 'generated') assert.equal(outcome.inserted.length, 0);
});

test('a dedup-cache warm failure does not fail the node (the durable DB write already happened)', async () => {
  const llm = createStubLlmClient(() => validReply);
  const { ctx } = makeContext({ llm });
  const failing: HypothesizeContext = {
    ...ctx,
    markSeen: async () => {
      throw new Error('redis down');
    },
  };

  const outcome = await hypothesize(failing, { scanId: 's1', userId: 'u1', surface });
  assert.equal(outcome.kind, 'generated');
});
