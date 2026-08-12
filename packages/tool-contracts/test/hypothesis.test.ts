import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  hypothesisCandidateSchema,
  hypothesisGenerationSchema,
  hypothesisPlanSchema,
  vulnClassSchema,
} from '../src/index.ts';

const validCandidate = {
  vulnClass: 'idor' as const,
  url: 'https://app.example.com/api/orders/42',
  method: 'GET' as const,
  param: { name: 'id', location: 'path' as const },
  payloadFamily: 'cross-session-object-read',
  rationale: 'Order id is a sequential path param and the endpoint returned data under session A.',
};

test('vulnClassSchema accepts the four v1 classes and rejects anything else', () => {
  for (const c of ['jwt', 'ssrf', 'injection', 'idor']) {
    assert.equal(vulnClassSchema.safeParse(c).success, true);
  }
  assert.equal(vulnClassSchema.safeParse('xss').success, false);
  assert.equal(vulnClassSchema.safeParse('').success, false);
});

test('a well-formed candidate parses', () => {
  const parsed = hypothesisCandidateSchema.parse(validCandidate);
  assert.equal(parsed.vulnClass, 'idor');
  assert.equal(parsed.param?.location, 'path');
});

test('param is optional (class-level tests carry no parameter)', () => {
  const parsed = hypothesisCandidateSchema.parse({
    vulnClass: 'jwt',
    url: 'https://app.example.com/api/session',
    method: 'GET',
    payloadFamily: 'alg-none',
    rationale: 'Endpoint accepts a bearer JWT; test an alg:none downgrade against the auth oracle.',
  });
  assert.equal(parsed.param, undefined);
});

test('candidate is strict — an unexpected field from the model is rejected, not ignored', () => {
  // The model must not be able to smuggle e.g. a pre-set fingerprint or status past validation.
  const result = hypothesisCandidateSchema.safeParse({ ...validCandidate, fingerprint: 'deadbeef' });
  assert.equal(result.success, false);
});

test('candidate rejects an unknown vuln class and empty required strings', () => {
  assert.equal(hypothesisCandidateSchema.safeParse({ ...validCandidate, vulnClass: 'rce' }).success, false);
  assert.equal(hypothesisCandidateSchema.safeParse({ ...validCandidate, rationale: '' }).success, false);
  assert.equal(hypothesisCandidateSchema.safeParse({ ...validCandidate, payloadFamily: '' }).success, false);
});

test('generation schema round-trips a batch and accepts an empty batch', () => {
  const parsed = hypothesisGenerationSchema.parse({ hypotheses: [validCandidate] });
  assert.equal(parsed.hypotheses.length, 1);
  assert.equal(hypothesisGenerationSchema.parse({ hypotheses: [] }).hypotheses.length, 0);
});

test('generation schema rejects a batch with any malformed candidate (fail closed, no partial)', () => {
  const result = hypothesisGenerationSchema.safeParse({
    hypotheses: [validCandidate, { ...validCandidate, vulnClass: 'nope' }],
  });
  assert.equal(result.success, false);
});

test('hypothesisPlanSchema accepts a v1 plan and rejects an unknown method or empty family', () => {
  const plan = hypothesisPlanSchema.parse({
    method: 'POST',
    param: { name: 'q', location: 'query' },
    payloadFamily: 'sql-error',
  });
  assert.equal(plan.method, 'POST');
  assert.equal(hypothesisPlanSchema.safeParse({ method: 'FETCH', payloadFamily: 'x' }).success, false);
  assert.equal(hypothesisPlanSchema.safeParse({ method: 'GET', payloadFamily: '' }).success, false);
});
