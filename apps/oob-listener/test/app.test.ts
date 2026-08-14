import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createLogger } from '@corvid/logger';
import type { OobCallback } from '@corvid/tool-contracts';

import { type AuditSink, createOobApp, type OobAuditEntry } from '../src/app.ts';
import { InMemoryOobStore } from '../src/store.ts';

const OOB = 'oob.test';
const SCAN_ID = '11111111-1111-4111-8111-111111111111';
const CONTROL_TOKEN = 'test-control-token-0123456789';
const AUTH = { authorization: `Bearer ${CONTROL_TOKEN}` };

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
    controlToken: CONTROL_TOKEN,
  });
  return { app, audit };
}

type App = ReturnType<typeof harness>['app'];

async function register(app: App): Promise<string> {
  const res = await app.request('/register', {
    method: 'POST',
    headers: { host: OOB, 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ scanId: SCAN_ID }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string; host: string };
  assert.equal(body.host, OOB);
  return body.token;
}

async function getCallback(app: App, token: string): Promise<OobCallback | null> {
  const res = await app.request(`/callbacks/${token}`, { headers: { host: OOB, ...AUTH } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { callback: OobCallback | null }).callback;
}

test('register mints a token, then a correlated callback records provenance readable via getCallback', async () => {
  const { app, audit } = harness();
  const token = await register(app);
  assert.equal(await getCallback(app, token), null);

  const cb = await app.request('/', { headers: { host: `${token}.${OOB}`, 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(cb.status, 200);
  assert.equal(await cb.text(), 'ok');

  const recorded = await getCallback(app, token);
  assert.ok(recorded, 'callback recorded');
  assert.equal(recorded?.sourceIp, '203.0.113.7');
  assert.equal(typeof recorded?.receivedAt, 'number');
  assert.ok(audit.entries.some((e) => e.action === 'oob.register' && e.scanId === SCAN_ID));
  assert.ok(audit.entries.some((e) => e.action === 'oob.callback' && e.scanId === SCAN_ID));
});

test('a callback on ANY path (not just /) is still recorded', async () => {
  const { app } = harness();
  const token = await register(app);
  const cb = await app.request('/latest/meta-data/', { headers: { host: `${token}.${OOB}` } });
  assert.equal(cb.status, 200);
  assert.ok(await getCallback(app, token));
});

test('a callback for an UNREGISTERED token records nothing (correlation guard)', async () => {
  const { app, audit } = harness();
  const unknown = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const cb = await app.request('/', { headers: { host: `${unknown}.${OOB}` } });
  assert.equal(cb.status, 200); // benign constant response — no oracle for probers
  assert.equal(await getCallback(app, unknown), null);
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

test('the control plane rejects a request with no/wrong bearer token (401)', async () => {
  const { app } = harness();
  const noAuth = await app.request('/register', {
    method: 'POST',
    headers: { host: OOB, 'content-type': 'application/json' },
    body: JSON.stringify({ scanId: SCAN_ID }),
  });
  assert.equal(noAuth.status, 401);

  const wrongAuth = await app.request(`/callbacks/deadbeefdeadbeefdeadbeefdeadbeef`, {
    headers: { host: OOB, authorization: 'Bearer nope' },
  });
  assert.equal(wrongAuth.status, 401);
});
