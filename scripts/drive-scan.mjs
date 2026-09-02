// Operational driver for an end-to-end Corvid scan against a live target, headless over the gateway
// HTTP API — the same flow the dashboard drives by hand, scripted so validation/calibration runs
// (Unit 8) are repeatable. It does exactly one thing HTTP can't: seed the target's pending
// proof-of-control token to the value the target already serves at /.well-known/corvid-challenge.txt,
// so authorization verifies through the REAL D-7 path without a target redeploy each run.
//
// Run:  node --env-file=.env scripts/drive-scan.mjs
// Env:  DATABASE_URL (root .env). Optional: GATEWAY (default http://localhost:8787),
//       TESTBED (default https://corvid-testbed.onrender.com), ORIGIN (default http://localhost:3024).
import { createRequire } from 'node:module';
// `pg` is a transitive dep (via @corvid/db); pnpm's isolated node_modules won't resolve it from the
// repo root, so require it from the db package where it's declared.
const require = createRequire(new URL('../packages/db/', import.meta.url));
const pg = require('pg');

const GATEWAY = process.env.GATEWAY ?? 'http://localhost:8787';
const TESTBED = process.env.TESTBED ?? 'https://corvid-testbed.onrender.com';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:3024';
const HOST = new URL(TESTBED).hostname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// A minimal cookie jar: capture Set-Cookie name=value pairs, replay them.
let cookie = '';
async function api(path, init = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { origin: ORIGIN, ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length > 0) {
    const jar = new Map(cookie ? cookie.split('; ').map((c) => c.split('=').slice(0, 1).concat(c.split('=').slice(1).join('='))) : []);
    for (const c of set) {
      const [k, ...v] = c.split(';', 1)[0].split('=');
      jar.set(k, v.join('='));
    }
    cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return res;
}
async function apiJson(path, init) {
  const res = await api(path, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body };
}
const post = (path, obj) => apiJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

async function testbedLogin(username, password) {
  const res = await fetch(`${TESTBED}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`testbed login ${username} failed: ${res.status}`);
  const { token } = await res.json();
  if (!token) throw new Error(`testbed login ${username}: no token`);
  return token;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set (run with: node --env-file=.env ...)');

  // 1. Fresh analyst account on the gateway (Better Auth email/password).
  const email = `driver-${Date.now()}@example.com`;
  const su = await post('/api/auth/sign-up/email', { email, password: 'a-strong-password-123', name: 'Driver' });
  if (su.status !== 200 && su.status !== 201) throw new Error(`sign-up failed: ${su.status} ${JSON.stringify(su.body)}`);
  log('signed up', email);

  // 2. Create the target with the testbed host in scope.
  const ct = await post('/api/targets', { url: TESTBED, scopeRules: { hosts: [HOST] } });
  if (ct.status !== 201) throw new Error(`create target failed: ${ct.status} ${JSON.stringify(ct.body)}`);
  const targetId = ct.body.id;
  log('target created', targetId);

  // 3. Read the challenge token the testbed already serves, and seed it as the target's PENDING proof
  //    directly in the DB, so the D-7 verify step matches without a target redeploy. This is the one
  //    step the HTTP API can't do (the gateway only MINTS a token); the value placed on the target is
  //    still what proves control — verification runs through the real verifyProofOfControl fetch.
  const wk = await fetch(`${TESTBED}/.well-known/corvid-challenge.txt`);
  if (!wk.ok) throw new Error(`well-known fetch failed: ${wk.status}`);
  const token = (await wk.text()).split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!token) throw new Error('well-known challenge token is empty');
  log('served challenge token', `${token.slice(0, 8)}…`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(
      `update targets set proof_of_control = $1::jsonb, updated_at = now() where id = $2`,
      [JSON.stringify({ status: 'pending', token, issuedAt: new Date().toISOString() }), targetId],
    );
    if (r.rowCount !== 1) throw new Error(`proof seed updated ${r.rowCount} rows`);
  } finally {
    await client.end();
  }
  log('seeded pending proof-of-control');

  // 4. Verify authorization through the real D-7 path.
  const auth = await post(`/api/targets/${targetId}/authorize`, { method: 'well_known' });
  if (auth.status !== 200 || auth.body.status !== 'authorized') {
    throw new Error(`authorize failed: ${auth.status} ${JSON.stringify(auth.body)}`);
  }
  log('target AUTHORIZED via', auth.body.method);

  // 5. Fresh testbed JWTs for the jwt + idor credentials.
  const [alice, bob] = await Promise.all([testbedLogin('alice', 'alice-password'), testbedLogin('bob', 'bob-password')]);
  log('got alice/bob JWTs');
  const credentials = {
    jwtSample: alice,
    idorSessions: {
      primary: { label: 'alice', headers: { Authorization: `Bearer ${alice}` } },
      secondary: { label: 'bob', headers: { Authorization: `Bearer ${bob}` } },
    },
  };

  // 6. Start the scan (runs to the approval interrupt in the background).
  const cs = await post('/api/scans', { targetId, credentials });
  if (cs.status !== 201) throw new Error(`create scan failed: ${cs.status} ${JSON.stringify(cs.body)}`);
  const scanId = cs.body.id;
  log('scan started', scanId, 'status', cs.body.status);

  // 7. Poll to the approval gate (crawl + hypothesize + plan run first).
  const scanStatus = async () => (await apiJson(`/api/scans/${scanId}`)).body.status;
  const deadlineApproval = Date.now() + 8 * 60_000;
  let status = cs.body.status;
  while (Date.now() < deadlineApproval) {
    status = await scanStatus();
    if (['awaiting_approval', 'completed', 'failed', 'stopped'].includes(status)) break;
    await sleep(5000);
    log('  …', status);
  }
  log('status at gate:', status);
  if (status === 'stopped') { log('scan stopped (no hypotheses generated) — nothing to approve'); return; }
  if (status !== 'awaiting_approval') throw new Error(`did not reach approval gate (status=${status})`);

  // 8. Show the hypotheses, then approve all of them.
  const hyp = (await apiJson(`/api/scans/${scanId}/hypotheses`)).body.hypotheses ?? [];
  log(`hypotheses (${hyp.length}):`);
  for (const h of hyp) log(`  - ${h.vulnClass.padEnd(9)} ${h.endpoint}  [${h.id.slice(0, 8)}]`);
  const ap = await post(`/api/scans/${scanId}/approvals`, { approvedHypotheses: hyp.map((h) => h.id) });
  if (ap.status !== 200) throw new Error(`approval failed: ${ap.status} ${JSON.stringify(ap.body)}`);
  log(`approved ${ap.body.approved?.length ?? 0}, rejected ${ap.body.rejected?.length ?? 0}`);

  // 9. Poll to terminal (observe = E2B burst, then verify, then reporting → completed).
  const deadlineDone = Date.now() + 12 * 60_000;
  while (Date.now() < deadlineDone) {
    status = await scanStatus();
    if (['completed', 'failed', 'stopped'].includes(status)) break;
    await sleep(5000);
    log('  …', status);
  }
  log('terminal status:', status);

  // 10. Findings + report.
  const findings = (await apiJson(`/api/scans/${scanId}/findings`)).body.findings ?? [];
  log(`\n=== FINDINGS (${findings.length}) ===`);
  for (const f of findings) {
    log(`  [${f.severity?.band ?? f.severity ?? '?'}] ${f.vulnClass}  payload=${JSON.stringify(f.payload)?.slice(0, 80)}`);
    log(`        proof: ${JSON.stringify(f.proof)?.slice(0, 200)}`);
  }
  const rep = (await apiJson(`/api/scans/${scanId}/report`)).body;
  log(`\nreport ready: ${rep.ready}  scanStatus: ${rep.scanStatus}`);
  log('scanId', scanId, ' targetId', targetId);
}

main().then(() => { log('done'); process.exit(0); }).catch((e) => { console.error('DRIVER FAILED:', e); process.exit(1); });
