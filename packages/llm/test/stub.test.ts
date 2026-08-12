import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import * as z from 'zod';

import { createStubLlmClient, type LlmPurpose } from '../src/index.ts';

const schema = z.object({ answer: z.string() }).strict();

test('stub returns validated data and the supplied cost for well-formed content', async () => {
  const client = createStubLlmClient(() => ({
    content: { answer: 'ok' },
    cost: { costCredits: 0.1, totalTokens: 3 },
  }));

  const result = await client.complete('hypothesize', [], schema);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.answer, 'ok');
  assert.equal(result.cost.costCredits, 0.1);
  assert.equal(result.cost.totalTokens, 3);
});

test('stub drives the invalid-output branch when content is not valid JSON', async () => {
  const client = createStubLlmClient(() => ({ content: 'not json at all' }));
  const result = await client.complete('hypothesize', [], schema);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'invalid_output');
});

test('stub drives the invalid-output branch when JSON parses but violates the schema', async () => {
  const client = createStubLlmClient(() => ({ content: { answer: 42 } }));
  const result = await client.complete('hypothesize', [], schema);
  assert.equal(result.ok, false);
});

test('stub receives the purpose and messages it was called with', async () => {
  let seenPurpose: LlmPurpose | undefined;
  let seenCount = -1;
  const client = createStubLlmClient((purpose, messages) => {
    seenPurpose = purpose;
    seenCount = messages.length;
    return { content: { answer: 'x' } };
  });

  await client.complete('report', [{ role: 'user', content: 'hi' }], schema);
  assert.equal(seenPurpose, 'report');
  assert.equal(seenCount, 1);
});

test('stub cost defaults to zero when not supplied', async () => {
  const client = createStubLlmClient(() => ({ content: { answer: 'x' } }));
  const result = await client.complete('hypothesize', [], schema);
  assert.equal(result.cost.costCredits, null);
  assert.equal(result.cost.totalTokens, 0);
});
