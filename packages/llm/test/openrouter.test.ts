import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isCorvidError } from '@corvid/errors';
import * as z from 'zod';

import { createOpenRouterClient, DEFAULT_MODELS } from '../src/index.ts';

const schema = z.object({ answer: z.string() }).strict();

const okBody = {
  model: 'google/gemini-2.5-flash',
  choices: [{ message: { content: JSON.stringify({ answer: 'hello' }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00042, is_byok: false },
};

interface FakeCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(body: unknown, opts: { status?: number } = {}): { fn: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(payload, { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
}

test('extracts validated data and per-call cost, and sends the cost opt-in + the package model slug', async () => {
  const { fn, calls } = fakeFetch(okBody);
  const client = createOpenRouterClient(
    { apiKey: 'sk-test', referer: 'https://corvid.local', title: 'Corvid' },
    { fetchFn: fn },
  );

  const result = await client.complete('hypothesize', [{ role: 'user', content: 'hi' }], schema);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.answer, 'hello');
  assert.equal(result.cost.costCredits, 0.00042);
  assert.equal(result.cost.totalTokens, 15);
  assert.equal(result.cost.isByok, false);

  const call = calls[0];
  assert.ok(call);
  assert.match(call.url, /\/chat\/completions$/);
  const sent = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal(sent.model, DEFAULT_MODELS.hypothesize); // slug from the llm package, not the caller
  assert.deepEqual(sent.usage, { include: true }); // ADR-21 cost opt-in
  assert.equal(sent.max_tokens, 4096); // bounded so a low-balance account doesn't 402
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test');
});

test('cost is still reported when output fails schema validation (record-before-parse, ADR-21)', async () => {
  const badBody = { ...okBody, choices: [{ message: { content: JSON.stringify({ answer: 123 }) } }] };
  const { fn } = fakeFetch(badBody);
  const client = createOpenRouterClient({ apiKey: 'x' }, { fetchFn: fn });

  const result = await client.complete('hypothesize', [{ role: 'user', content: 'hi' }], schema);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'invalid_output');
  assert.equal(result.cost.costCredits, 0.00042); // cost known despite invalid output
});

test('empty content is an invalid_output outcome, not a crash', async () => {
  const emptyBody = { ...okBody, choices: [{ message: { content: '' } }] };
  const { fn } = fakeFetch(emptyBody);
  const client = createOpenRouterClient({ apiKey: 'x' }, { fetchFn: fn });

  const result = await client.complete('hypothesize', [{ role: 'user', content: 'hi' }], schema);
  assert.equal(result.ok, false);
});

test('a 5xx/429 is a retryable InfraError; a 4xx is not retryable', async () => {
  const cases: readonly [number, boolean][] = [
    [503, true],
    [429, true],
    [400, false],
  ];
  for (const [status, retryable] of cases) {
    const { fn } = fakeFetch({}, { status });
    const client = createOpenRouterClient({ apiKey: 'x' }, { fetchFn: fn });
    await assert.rejects(
      client.complete('hypothesize', [{ role: 'user', content: 'hi' }], schema),
      (err: unknown) => isCorvidError(err) && err.kind === 'infra' && err.retryable === retryable,
    );
  }
});

test('a transport failure is a retryable InfraError (never a clean negative, §4)', async () => {
  const fn = (async () => {
    throw new Error('econnrefused');
  }) as unknown as typeof fetch;
  const client = createOpenRouterClient({ apiKey: 'x' }, { fetchFn: fn });

  await assert.rejects(
    client.complete('hypothesize', [{ role: 'user', content: 'hi' }], schema),
    (err: unknown) => isCorvidError(err) && err.kind === 'infra' && err.retryable === true,
  );
});

test('an unexpected response shape from the gateway is a retryable InfraError', async () => {
  const { fn } = fakeFetch({ nonsense: true }); // no choices[]
  const client = createOpenRouterClient({ apiKey: 'x' }, { fetchFn: fn });
  await assert.rejects(
    client.complete('hypothesize', [{ role: 'user', content: 'hi' }], schema),
    (err: unknown) => isCorvidError(err) && err.kind === 'infra',
  );
});
