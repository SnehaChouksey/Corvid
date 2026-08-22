import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { InfraError } from '@corvid/errors';

import { createLogger, withFields } from '../src/index.ts';

// Collect each NDJSON line pino writes so we can assert on structured output without touching stdout.
function capturing(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => void lines.push(s) };
}

function lastRecord(lines: string[]): Record<string, unknown> {
  const line = lines.at(-1);
  assert.ok(line, 'expected at least one log line');
  return JSON.parse(line) as Record<string, unknown>;
}

test('base service field and message are emitted', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'agent-core', destination: sink });
  log.info({ scan_id: 's1' }, 'scan started');
  const rec = lastRecord(sink.lines);
  assert.equal(rec['service'], 'agent-core');
  assert.equal(rec['scan_id'], 's1');
  assert.equal(rec['msg'], 'scan started');
});

test('secret fields are redacted structurally, case-insensitively (CODING_STANDARDS §5)', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'x', destination: sink });
  log.info(
    {
      password: 'hunter2',
      // snake_case, header casing, and camelCase spellings all caught.
      api_key: 'k',
      Authorization: 'Bearer z',
      response_body: '<html>secret</html>',
      encryptionKey: 'e',
      scan_id: 's1',
    },
    'auth',
  );
  const rec = lastRecord(sink.lines);
  assert.equal(rec['password'], '[REDACTED]');
  assert.equal(rec['api_key'], '[REDACTED]');
  assert.equal(rec['Authorization'], '[REDACTED]');
  assert.equal(rec['response_body'], '[REDACTED]');
  assert.equal(rec['encryptionKey'], '[REDACTED]');
  assert.equal(rec['scan_id'], 's1'); // non-secret field is untouched
});

test('secrets nested deep in an envelope are redacted (not just one level)', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'x', destination: sink });
  log.info(
    { tool_result: { request: { headers: { authorization: 'Bearer DEEP' } } }, scan_id: 's1' },
    'tool call',
  );
  const rec = lastRecord(sink.lines);
  const toolResult = rec['tool_result'] as { request?: { headers?: Record<string, unknown> } };
  assert.equal(toolResult.request?.headers?.['authorization'], '[REDACTED]');
});

test('a secret interpolated into the MESSAGE string is NOT redacted — proves why §5 forbids it', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'x', destination: sink });
  // Deliberately wrong usage: redaction walks object paths only, never the message text.
  log.info({}, 'token=SUPERSECRET');
  const rec = lastRecord(sink.lines);
  assert.equal(rec['msg'], 'token=SUPERSECRET'); // leaked — hence: pass secrets as fields, never inline
});

test('extra redactKeys merge with the defaults', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'x', destination: sink, redactKeys: ['ssn'] });
  log.info({ ssn: '000-00-0000', password: 'p' }, 'pii');
  const rec = lastRecord(sink.lines);
  assert.equal(rec['ssn'], '[REDACTED]');
  assert.equal(rec['password'], '[REDACTED]'); // default still applies
});

test('a CorvidError serializes to safe structured fields with its context scrubbed', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'x', destination: sink });
  const err = new InfraError('oob listener unreachable', {
    retryable: true,
    context: { scan_id: 's1', component: 'oob' },
  });
  log.error({ err }, 'infra failure');
  const rec = lastRecord(sink.lines);
  const serialized = rec['err'] as Record<string, unknown>;
  assert.equal(serialized['type'], 'InfraError');
  assert.equal(serialized['kind'], 'infra');
  assert.equal(serialized['retryable'], true);
  assert.equal(serialized['msg'], 'oob listener unreachable');
  assert.equal((serialized['context'] as Record<string, unknown>)['scan_id'], 's1');
  assert.ok(typeof serialized['stack'] === 'string');
});

test('a forced error carrying secrets in its context has them scrubbed on the error path (§5, Unit 8)', () => {
  const sink = capturing();
  const log = createLogger({ level: 'error', service: 'http-send', destination: sink });
  // The realistic forced-failure shape: a tool-server error whose context carries request details —
  // an Authorization header, the analyst's session cookie, and the raw target response body. All must
  // be redacted in the serialized `err.context`, while non-secret identifiers survive for debugging.
  const err = new InfraError('target returned 500 during a send', {
    retryable: true,
    context: {
      scan_id: 's1',
      endpoint: '/api/orders/1',
      authorization: 'Bearer super-secret-jwt',
      cookie: 'session=analyst-session-token',
      response_body: '<html>SENSITIVE TARGET DATA</html>',
    },
  });
  log.error({ err }, 'send failed');

  const rec = lastRecord(sink.lines);
  const ctx = (rec['err'] as Record<string, unknown>)['context'] as Record<string, unknown>;
  assert.equal(ctx['authorization'], '[REDACTED]');
  assert.equal(ctx['cookie'], '[REDACTED]');
  assert.equal(ctx['response_body'], '[REDACTED]');
  assert.equal(ctx['scan_id'], 's1'); // non-secret id survives
  assert.equal(ctx['endpoint'], '/api/orders/1');
  // Defense in depth: the whole serialized line must not contain any secret substring, anywhere.
  const line = sink.lines.at(-1) ?? '';
  for (const secret of ['super-secret-jwt', 'analyst-session-token', 'SENSITIVE TARGET DATA']) {
    assert.ok(!line.includes(secret), `secret leaked into the log line: ${secret}`);
  }
});

test('withFields binds standard fields onto a child logger (§13)', () => {
  const sink = capturing();
  const log = createLogger({ level: 'info', service: 'x', destination: sink });
  const child = withFields(log, { scan_id: 's2', vuln_class: 'jwt' });
  child.warn({ endpoint: '/api/login' }, 'testing');
  const rec = lastRecord(sink.lines);
  assert.equal(rec['scan_id'], 's2');
  assert.equal(rec['vuln_class'], 'jwt');
  assert.equal(rec['endpoint'], '/api/login');
});

test('level threshold suppresses lower-severity lines', () => {
  const sink = capturing();
  const log = createLogger({ level: 'warn', service: 'x', destination: sink });
  log.info({}, 'suppressed');
  assert.equal(sink.lines.length, 0);
  log.warn({}, 'emitted');
  assert.equal(sink.lines.length, 1);
});
