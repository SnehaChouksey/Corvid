import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { HypothesisRow } from '@corvid/db';
import type { HypothesisPlan } from '@corvid/tool-contracts';

import { plan, type PlanContext } from '../src/index.ts';

function row(over: Partial<HypothesisRow> = {}): HypothesisRow {
  return {
    id: 'h1',
    scanId: 's1',
    vulnClass: 'idor',
    endpoint: 'GET https://app.example.com/api/orders/1',
    rationale: 'Sequential id.',
    fingerprint: 'fp1',
    status: 'pending',
    plan: { method: 'GET', payloadFamily: 'cross-session-read', param: { name: 'id', location: 'path' } },
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
    ...over,
  };
}

test('plan selects the tester and writes an intended payload for each pending hypothesis', async () => {
  const writes: { id: string; plan: HypothesisPlan }[] = [];
  const ctx: PlanContext = {
    listPending: async () => [row()],
    setPlan: async (_scanId, id, p) => {
      writes.push({ id, plan: p });
    },
  };

  const outcome = await plan(ctx, 's1');

  assert.equal(outcome.planned, 1);
  assert.equal(writes[0]?.plan.tool, 'idor.compare');
  assert.equal(writes[0]?.plan.payloadFamily, 'cross-session-read'); // base fields preserved
  assert.match(writes[0]?.plan.intendedPayload ?? '', /IDOR/);
});

test('plan maps each vuln class to its Unit 4 tool', async () => {
  const expected: Record<string, string> = {
    jwt: 'jwt.mutate_test',
    injection: 'injection.fuzz',
    ssrf: 'ssrf.check',
    idor: 'idor.compare',
  };
  for (const [vulnClass, tool] of Object.entries(expected)) {
    const writes: HypothesisPlan[] = [];
    const ctx: PlanContext = {
      listPending: async () => [
        row({ vulnClass: vulnClass as HypothesisRow['vulnClass'], plan: { method: 'POST', payloadFamily: 'fam' } }),
      ],
      setPlan: async (_s, _id, p) => {
        writes.push(p);
      },
    };
    await plan(ctx, 's1');
    assert.equal(writes[0]?.tool, tool);
  }
});

test('plan is idempotent — an already-planned hypothesis is skipped', async () => {
  let writes = 0;
  const ctx: PlanContext = {
    listPending: async () => [
      row({ plan: { method: 'GET', payloadFamily: 'x', tool: 'idor.compare', intendedPayload: 'done' } }),
    ],
    setPlan: async () => {
      writes++;
    },
  };
  const outcome = await plan(ctx, 's1');
  assert.equal(outcome.planned, 0);
  assert.equal(writes, 0);
});

test('plan skips a pending hypothesis with no base plan rather than fabricating one', async () => {
  let writes = 0;
  const ctx: PlanContext = {
    listPending: async () => [row({ plan: null })],
    setPlan: async () => {
      writes++;
    },
  };
  const outcome = await plan(ctx, 's1');
  assert.equal(outcome.planned, 0);
  assert.equal(writes, 0);
});
