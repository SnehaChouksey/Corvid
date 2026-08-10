import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ConfigError, isCorvidError } from '@corvid/errors';
import * as z from 'zod';

import { parseEnv } from '../src/index.ts';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.url(),
});

test('valid environment parses and coerces to typed config', () => {
  const env = parseEnv(schema, {
    NODE_ENV: 'test',
    PORT: '8080',
    DATABASE_URL: 'postgres://localhost:5432/corvid',
  });
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.PORT, 8080); // coerced string -> number
  assert.equal(typeof env.PORT, 'number');
});

test('missing/invalid values throw a ConfigError naming the failing fields', () => {
  let thrown: unknown;
  try {
    parseEnv(schema, { NODE_ENV: 'staging', DATABASE_URL: 'not-a-url' });
  } catch (err) {
    thrown = err;
  }
  assert.ok(isCorvidError(thrown));
  assert.ok(thrown instanceof ConfigError);
  assert.equal(thrown.kind, 'config');
  assert.equal(thrown.retryable, false);
  // Reports each failing field path.
  assert.match(thrown.message, /NODE_ENV/);
  assert.match(thrown.message, /PORT/);
  assert.match(thrown.message, /DATABASE_URL/);
});

test('a malformed secret value never leaks into the error message (CODING_STANDARDS §5)', () => {
  // Missing scheme => unambiguously rejected by z.url(), while still carrying the secret token.
  const secret = 'SUPERSECRETPASSWORD-this-is-not-a-url';
  let thrown: unknown;
  try {
    parseEnv(schema, { NODE_ENV: 'production', PORT: '1', DATABASE_URL: secret });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ConfigError);
  // The received value must not appear anywhere in the surfaced error text.
  assert.equal(thrown.message.includes('SUPERSECRETPASSWORD'), false);
  assert.match(thrown.message, /DATABASE_URL/); // but the field is still named
});

test('a throwing transform escapes as a ConfigError, never a raw error (§4)', () => {
  const throwing = z.object({
    SECRET: z.string().transform((v) => {
      throw new Error(`boom ${v}`); // a non-Zod throw inside parsing
    }),
  });
  let thrown: unknown;
  try {
    parseEnv(throwing, { SECRET: 'LEAKME' });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ConfigError);
  assert.equal(thrown.message.includes('LEAKME'), false); // thrown detail is not echoed
});

test('a custom refinement message is not echoed (author-controlled, untrusted for §5)', () => {
  const refined = z.object({
    SECRET: z.string().refine(() => false, { error: 'contains SUPERSECRETPASSWORD' }),
  });
  let thrown: unknown;
  try {
    parseEnv(refined, { SECRET: 'x' });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ConfigError);
  assert.equal(thrown.message.includes('SUPERSECRETPASSWORD'), false);
  assert.match(thrown.message, /failed custom validation/);
});
