import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';

import {
  createDb,
  type DbHandle,
  recordLlmCall,
  runMigrations,
  schema,
  type SpendCeilings,
} from '@corvid/db';
import { createStubLlmClient } from '@corvid/llm';

import { createHypothesizeContext, hypothesize, type PerceivedSurface } from '../src/index.ts';

// Unit 8 forced safety-audit test: the LLM daily spend kill-switch (ADR-21) fires through the REAL
// ledger. The agent-core unit test proves the short-circuit with an INJECTED dailySpend; this proves
// the whole path — a real `llm_calls` ledger → `sumDailyLlmSpend` → `evaluateDailySpend` → the node
// refuses BEFORE spending — against a real Postgres. A stub LLM flips a flag if it is ever reached, so
// once the cap is tripped we prove no billed call happens (the kill-switch degrades reasoning only,
// never the verification gate — ADR-01). Opt-in via DATABASE_URL; skips cleanly otherwise.

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL === undefined) {
  test('spend kill-switch integration (skipped — set DATABASE_URL with a running Postgres)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;

  // A non-empty surface, so the node reaches the spend gate (an empty surface short-circuits earlier).
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

  async function seedScan(email: string): Promise<{ userId: string; scanId: string }> {
    const uRows = await handle.db.insert(schema.users).values({ name: 'Spend', email }).returning();
    const u = uRows[0];
    assert.ok(u);
    const tRows = await handle.db
      .insert(schema.targets)
      .values({ ownerId: u.id, url: 'https://app.example.com', scopeRules: {} })
      .returning();
    const t = tRows[0];
    assert.ok(t);
    const sRows = await handle.db
      .insert(schema.scans)
      .values({ ownerId: u.id, targetId: t.id, status: 'hypothesizing' })
      .returning();
    const s = sRows[0];
    assert.ok(s);
    return { userId: u.id, scanId: s.id };
  }

  // A context whose LLM flips a flag if ever reached, and whose dedup/persist ports throw — so a spend
  // stop that reached them (a bug) fails loudly instead of silently passing.
  function guardedContext(ceilings: SpendCeilings): { ctx: ReturnType<typeof createHypothesizeContext>; wasLlmCalled: () => boolean } {
    let llmCalled = false;
    const ctx = createHypothesizeContext({
      db: handle.db,
      llm: createStubLlmClient(() => {
        llmCalled = true;
        return { content: { hypotheses: [] } };
      }),
      dedupFor: () => {
        throw new Error('dedup must never be reached on a spend stop');
      },
      ceilings,
    });
    return { ctx, wasLlmCalled: () => llmCalled };
  }

  before(async () => {
    handle = createDb(databaseUrl);
    await runMigrations(handle);
  });

  test('per-user cap: a user over their daily ceiling is refused BEFORE any billed LLM call', async () => {
    const { userId, scanId } = await seedScan(`spend-user-${Date.now()}@example.com`);
    // Seed spend for THIS user above a tiny per-user ceiling; the global ceiling is set huge so the
    // per-user scope is unambiguously the one that trips.
    await recordLlmCall(handle.db, {
      scanId,
      userId,
      purpose: 'hypothesize',
      model: 'google/gemini-2.5-flash-lite',
      costCredits: 0.5,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      isByok: false,
    });

    const { ctx, wasLlmCalled } = guardedContext({ globalCeilingCredits: 1e9, userCeilingCredits: 0.001 });
    const outcome = await hypothesize(ctx, { scanId, userId, surface });

    assert.equal(outcome.kind, 'spend_stopped');
    if (outcome.kind === 'spend_stopped') assert.equal(outcome.scope, 'user');
    assert.equal(wasLlmCalled(), false, 'the LLM must not be called once the cap is tripped');
  });

  test('global cap: spend over the global ceiling refuses even when the user is under theirs', async () => {
    const { userId, scanId } = await seedScan(`spend-global-${Date.now()}@example.com`);
    // A real billed row makes the day's global sum strictly positive; a tiny global ceiling is then
    // already exceeded while the per-user ceiling is huge — so `global` is the scope that trips.
    await recordLlmCall(handle.db, {
      scanId,
      userId,
      purpose: 'hypothesize',
      model: 'google/gemini-2.5-flash-lite',
      costCredits: 0.5,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      isByok: false,
    });

    const { ctx, wasLlmCalled } = guardedContext({ globalCeilingCredits: 1e-9, userCeilingCredits: 1e9 });
    const outcome = await hypothesize(ctx, { scanId, userId, surface });

    assert.equal(outcome.kind, 'spend_stopped');
    if (outcome.kind === 'spend_stopped') assert.equal(outcome.scope, 'global');
    assert.equal(wasLlmCalled(), false);
  });
}
