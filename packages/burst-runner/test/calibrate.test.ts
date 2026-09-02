/* eslint-disable no-console -- this is an opt-in measurement harness whose whole job is to PRINT the
   raw calibration tables to stdout; it is skipped unless CALIBRATE=1 and never runs in the gate. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { BurstHypothesis, BurstInput, TesterObservation } from '@corvid/tool-contracts';

import { runBurst } from '../src/run.ts';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// D-13–D-16 threshold CALIBRATION harness (Unit 8). Opt-in (needs a live testbed + network), so it is
// gated on CALIBRATE=1 and skipped in the normal gate. It runs the REAL tester composition (runBurst
// = @corvid/http-send + the four testers, the exact code the sandbox runs) against the deployed
// corvid-testbed and DUMPS the raw observation signals — the timings/statuses/body hashes the verify
// gate thresholds act on — so the thresholds can be set from measured separation, not paper values.
//
//   CALIBRATE=1 CALIBRATE_RUNS=3 TESTBED=https://corvid-testbed.onrender.com \
//     node --test packages/burst-runner/test/calibrate.test.ts
//
// It asserts nothing about thresholds (it MEASURES); the analysis is read off the printed tables.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const TESTBED = process.env.TESTBED ?? 'https://corvid-testbed.onrender.com';
const HOST = new URL(TESTBED).hostname;
const RUNS = Number(process.env.CALIBRATE_RUNS ?? '1');

// The verify-gate injection thresholds (mirrored here for the report; source: @corvid/verify/injection).
const T = { MIN_2S_DELAY_MS: 1500, MIN_4S_DELAY_MS: 3500, SCALE_LOW: 1.6, SCALE_HIGH: 2.4 };

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${TESTBED}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`testbed login ${username}: ${res.status}`);
  return (await res.json() as { token: string }).token;
}

async function warm(): Promise<void> {
  // Render free instances sleep; wake every endpoint so cold-starts don't distort timing.
  await Promise.all(
    ['/', '/api/search', '/api/products', '/api/lookup', '/api/login'].map((p) =>
      fetch(`${TESTBED}${p}`, { method: 'GET' }).catch(() => undefined),
    ),
  );
}

const injHyp = (path: string, param: string): BurstHypothesis => ({
  hypothesisId: randomUUID(),
  vulnClass: 'injection',
  url: `${TESTBED}${path}`,
  method: 'POST',
  param: { name: param, location: 'body' },
  payloadFamily: 'sqli',
});

function fmt(n: number): string {
  return `${Math.round(n)}`.padStart(6);
}

function reportInjection(label: string, expected: string, obs: TesterObservation | null): void {
  if (obs === null || obs.vulnClass !== 'injection') {
    console.log(`  [injection] ${label} (${expected}): NO OBSERVATION (tester could not send)`);
    return;
  }
  console.log(`  [injection] ${label} (${expected}):`);
  for (const a of obs.attempts) {
    const delta = a.injected.timingMs - a.baseline.timingMs;
    const errs = a.matchedErrorPatterns.length > 0 ? a.matchedErrorPatterns.join(',') : '-';
    console.log(
      `      ${a.payloadFamily.padEnd(18)} base=${fmt(a.baseline.timingMs)}ms inj=${fmt(a.injected.timingMs)}ms Δ=${fmt(delta)}ms  st=${a.injected.status}  err=${errs}`,
    );
  }
  // Replicate the gate's two signals so the printout shows WHY it would confirm / not.
  const control = obs.attempts.find((a) => a.payloadFamily === 'escaped-control');
  const controlClean = control === undefined || control.matchedErrorPatterns.length === 0;
  const errored = obs.attempts.find(
    (a) => a.injectionClass === 'sqli_error' && a.payloadFamily !== 'escaped-control' && a.matchedErrorPatterns.length > 0,
  );
  const errorBased = errored !== undefined && controlClean;
  let dose = 'none';
  for (const dialect of ['pg-sleep', 'mysql-sleep']) {
    const a2 = obs.attempts.find((a) => a.payloadFamily === `${dialect}-2s`);
    const a4 = obs.attempts.find((a) => a.payloadFamily === `${dialect}-4s`);
    if (a2 === undefined || a4 === undefined) continue;
    const d2 = a2.injected.timingMs - a2.baseline.timingMs;
    const d4 = a4.injected.timingMs - a4.baseline.timingMs;
    const scale = d2 !== 0 ? d4 / d2 : 0;
    const pass = d2 >= T.MIN_2S_DELAY_MS && d4 >= T.MIN_4S_DELAY_MS && scale >= T.SCALE_LOW && scale <= T.SCALE_HIGH;
    dose = `${dialect}: d2=${Math.round(d2)} d4=${Math.round(d4)} scale=${scale.toFixed(2)} → ${pass ? 'PASS' : 'fail'}`;
    if (pass) break;
  }
  console.log(`      ⇒ error-based=${errorBased ? 'CONFIRM' : 'no'} | dose-response=${dose} | controlClean=${controlClean}`);
}

function sig(s: { status: number; bodyLength: number; bodyHash: string }): string {
  return `st=${s.status} len=${s.bodyLength} hash=${s.bodyHash.slice(0, 10)}`;
}

test('D-13–D-16 signal calibration against the live testbed', { skip: process.env.CALIBRATE !== '1' }, async () => {
  await warm();
  const [alice, bob] = await Promise.all([login('alice', 'alice-password'), login('bob', 'bob-password')]);
  const credentials = {
    jwtSample: alice,
    idorSessions: {
      primary: { label: 'alice', headers: { Authorization: `Bearer ${alice}` } },
      secondary: { label: 'bob', headers: { Authorization: `Bearer ${bob}` } },
    },
  };

  const injHyps = [
    { h: injHyp('/api/search', 'q'), label: '/api/search q', expected: 'VULN' },
    { h: injHyp('/api/products', 'category'), label: '/api/products category', expected: 'VULN' },
    { h: injHyp('/api/lookup', 'code'), label: '/api/lookup code', expected: 'true-neg' },
    { h: injHyp('/api/login', 'username'), label: '/api/login username', expected: 'true-neg' },
  ];
  const jwtHyp: BurstHypothesis = {
    hypothesisId: randomUUID(), vulnClass: 'jwt', url: `${TESTBED}/api/me`, method: 'GET', payloadFamily: 'jwt',
  };
  const idorHyp: BurstHypothesis = {
    hypothesisId: randomUUID(), vulnClass: 'idor', url: `${TESTBED}/api/orders/1`, method: 'GET', payloadFamily: 'idor',
  };

  const input: BurstInput = {
    scanId: randomUUID(),
    scope: { hosts: [HOST] },
    credentials,
    hypotheses: [...injHyps.map((x) => x.h), jwtHyp, idorHyp],
  };

  console.log(`\n===== CALIBRATION vs ${TESTBED} (${RUNS} run(s)) =====`);
  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n----- run ${run}/${RUNS} -----`);
    // Fresh hypothesis ids each run so the per-burst dedup doesn't suppress repeat timing samples.
    const perRun: BurstInput = {
      ...input,
      hypotheses: input.hypotheses.map((h) => ({ ...h, hypothesisId: randomUUID() })),
    };
    // Cap http.send's pacing delay: the rate limiter (500ms base, ×2 backoff to 15s on any 403/429)
    // makes a 60-request burst against a throttling free-tier host take many minutes and never affects
    // the SIGNAL (each response's own timingMs is what the gate reads). Cap it at 200ms for a gentle,
    // fast measurement. The 2s/4s sleep payloads still execute for real — that IS the dose signal.
    const out = await runBurst(perRun, {
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, Math.min(ms, 200)));
      },
    });
    const byId = new Map(out.observations.map((o) => [o.hypothesisId, o.observation]));
    const ids = perRun.hypotheses;
    injHyps.forEach((x, i) => reportInjection(x.label, x.expected, byId.get(ids[i]!.hypothesisId) ?? null));

    const jwtObs = byId.get(ids[injHyps.length]!.hypothesisId);
    if (jwtObs != null && jwtObs.vulnClass === 'jwt') {
      console.log(`  [jwt] /api/me:  noToken(${sig(jwtObs.noToken)})  valid(${sig(jwtObs.validToken)})`);
      for (const m of jwtObs.mutations) {
        const sameAsValid = m.signal.status === jwtObs.validToken.status && m.signal.bodyHash === jwtObs.validToken.bodyHash;
        const diffNoTok = !(m.signal.status === jwtObs.noToken.status && m.signal.bodyHash === jwtObs.noToken.bodyHash);
        console.log(`      ${m.kind.padEnd(14)} ${sig(m.signal)}  sameAsValid=${sameAsValid} differsFromNoToken=${diffNoTok} → ${sameAsValid && diffNoTok ? 'CONFIRM' : 'no'}`);
      }
    }

    const idorObs = byId.get(ids[injHyps.length + 1]!.hypothesisId);
    if (idorObs != null && idorObs.vulnClass === 'idor') {
      console.log(`  [idor] /api/orders/1:`);
      console.log(`      lowPriv(bob)   ${sig(idorObs.lowPrivilege)}`);
      console.log(`      highPriv(alice)${sig(idorObs.highPrivilege)}`);
      if (idorObs.controlSelf) console.log(`      controlSelf    ${sig(idorObs.controlSelf)}`);
      if (idorObs.controlAbsent) console.log(`      controlAbsent  ${sig(idorObs.controlAbsent)}`);
      if (idorObs.controlUnauth) console.log(`      controlUnauth  ${sig(idorObs.controlUnauth)}`);
    }
    if (out.errors.length > 0) console.log(`  errors: ${JSON.stringify(out.errors)}`);
  }
  console.log('\n===== end calibration =====\n');
});
