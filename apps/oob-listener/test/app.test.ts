import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createLogger } from '@corvid/logger';

import { type AuditSink, createOobApp, type OobAuditEntry } from '../src/app.ts';
import { InMemoryOobStore } from '../src/store.ts';

const OOB = 'oob.test';
const SCAN_ID = '11111111-1111-4111-8111-111111111111';

class FakeAudit implements AuditSink {
  readonly entries: OobAuditEntry[] = [];
  async append(entry: OobAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function harness() {
  const audit = new FakeAudit();
  const app = createOobApp({
    store: new InMemoryOobStore(),
    audit,
    logger: createLogger({ level: 'silent', service: 'test' }),
    oobHost: OOB,
  });
  return { app, audit };
}

async function register(app: ReturnType<typeof harness>['app']): Promise<string> {
  const res = await app.request('/register', {
    method: 'POST',
    headers: { host: OOB, 'content-type': 'application/json' },
    body: JSON.stringify({ scanId: SCAN_ID }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string; host: string };
  assert.equal(body.host, OOB);
  return body.token;
}

async function calledBack(app: ReturnType<typeof harness>['app'], token: string): Promise<boolean> {
  const res = await app.request(`/callbacks/${token}`, { headers: { host: OOB } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { calledBack: boolean }).calledBack;
}

test('register mints a token, then a correlated callback flips wasCalledBack to true', async () => {
  const { app, audit } = harness();
  const token = await register(app);
  assert.equal(await calledBack(app, token), false);

  const cb = await app.request('/', { headers: { host: `${token}.${OOB}` } });
  assert.equal(cb.status, 200);
  assert.equal(await cb.text(), 'ok');

  assert.equal(await calledBack(app, token), true);
  assert.ok(audit.entries.some((e) => e.action === 'oob.register' && e.scanId === SCAN_ID));
  assert.ok(audit.entries.some((e) => e.action === 'oob.callback' && e.scanId === SCAN_ID));
});

test('a callback on ANY path (not just /) is still recorded', async () => {
  const { app } = harness();
  const token = await register(app);
  const cb = await app.request('/latest/meta-data/', { headers: { host: `${token}.${OOB}` } });
  assert.equal(cb.status, 200);
  assert.equal(await calledBack(app, token), true);
});

test('a callback for an UNREGISTERED token records nothing (correlation guard)', async () => {
  const { app, audit } = harness();
  const unknown = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const cb = await app.request('/', { headers: { host: `${unknown}.${OOB}` } });
  assert.equal(cb.status, 200); // benign constant response — no oracle for probers
  assert.equal(await calledBack(app, unknown), false);
  assert.equal(
    audit.entries.some((e) => e.action === 'oob.callback'),
    false,
  );
});

test('a request to a foreign host is ignored (404), never recorded', async () => {
  const { app } = harness();
  const res = await app.request('/', { headers: { host: 'evil.com' } });
  assert.equal(res.status, 404);
});
