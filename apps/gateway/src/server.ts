import { lookup, resolveTxt } from 'node:dns/promises';

import { createAuth } from '@corvid/auth';
import { createCipher, loadKey } from '@corvid/crypto';
import {
  createDb,
  insertFinding,
  recordApprovalDecision,
  requestScanCancel,
  setScanStatus,
} from '@corvid/db';
import { InfraError } from '@corvid/errors';
import { createLogger } from '@corvid/logger';
import type { ProofPorts } from '@corvid/proof-of-control';
import { createRedis, honoRateLimitClient } from '@corvid/redis';
import {
  buildScanGraph,
  createCheckpointer,
  createScanRuntimeService,
  type ScanGraphDeps,
} from '@corvid/scan-runtime';
import { serve } from '@hono/node-server';
import { RedisStore, type Store } from 'hono-rate-limiter';

import { type AppEnv, createApp } from './app.ts';
import { loadEnv } from './env.ts';

// Real IO for D-7 proof-of-control. The SSRF guard (dangerous host / dangerous resolved IP) lives in
// @corvid/proof-of-control; these ports just do the IO. The fetch REFUSES redirects (`redirect:
// 'error'`) so a well-known file can't 302 the request to an internal host, and is time-bounded.
const proofPorts: ProofPorts = {
  resolveTxt: (name) => resolveTxt(name),
  resolveHostIps: async (host) => {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((r) => r.address);
  },
  fetchText: async (url, timeoutMs) => {
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Corvid-ProofOfControl/1.0' },
    });
    // The challenge file is tiny; cap what we read so a hostile large body can't be a memory DoS.
    const body = (await res.text()).slice(0, 8_192);
    return { ok: res.ok, status: res.status, body };
  },
};

// Composition root: validate env (fail closed), wire dependencies, serve. Nothing here has logic
// beyond wiring — the app is testable without a listening socket via `createApp(...).fetch`.
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, service: 'gateway' });
const { db } = createDb(env.DATABASE_URL);
// Bind the credential cipher once at boot; loadKey fails closed on a bad/short key (§9).
const credentialCipher = createCipher(loadKey(env.ENCRYPTION_KEY));
const trustedOrigins = env.TRUSTED_ORIGINS?.split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const auth = createAuth({
  database: db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  ...(trustedOrigins !== undefined && trustedOrigins.length > 0 ? { trustedOrigins } : {}),
  // Enable Google sign-in only when both credentials are present (env enforces both-or-neither).
  ...(env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
    : {}),
});

// ── Durable scan runtime (ADR-27), co-located in the gateway process for v1 (ADR-33) ──────────────
// The service is the seam the gateway signals the workflow through. The DB ports (status sync,
// approval decision, cancel) are LIVE — the human approval gate records its decision durably here.
// The graph's REASONING and TESTER deps (crawl/hypothesize/plan/observe) are NOT yet wired: live
// testing needs the crawler process, OpenRouter, E2B + the tester tools (external prerequisites,
// Unit 0/8). They throw a typed InfraError until then, so a started scan fails fast and audibly
// rather than pretending to run. persistFinding is real (verified-only store); OOB confirmation is
// wired when the listener store lands. The periodic OOB-timeout sweep (resolver already built +
// tested) is scheduled by the dedicated scan-runtime worker, not the gateway — Unit 8.
const { checkpointer } = await createCheckpointer(env.DATABASE_URL);
const notLive = (op: string): never => {
  throw new InfraError(`scan-runtime dep '${op}' is not wired yet (live testing is Unit 0/8)`, {
    retryable: false,
  });
};
const graphDeps: ScanGraphDeps = {
  crawl: async () => notLive('crawl'),
  hypothesize: async () => notLive('hypothesize'),
  plan: async () => notLive('plan'),
  observe: async () => notLive('observe'),
  persistFinding: async (f) => {
    await insertFinding(db, {
      hypothesisId: f.hypothesisId,
      vulnClass: f.vulnClass,
      payload: f.payload,
      proof: f.proof,
      severity: f.severity,
    });
  },
  // No OOB confirmation until the listener store is wired (Unit 0/8); a blind SSRF then times out to
  // not_confirmed, which is the safe default (never a false positive).
  oob: { getCallback: async () => null },
};
const scanRuntime = createScanRuntimeService({
  graph: buildScanGraph(checkpointer, graphDeps),
  persistStatus: (scanId, status) => setScanStatus(db, scanId, status),
  recordApproval: (scanId, ownerId, approved) =>
    recordApprovalDecision(db, { scanId, ownerId, approvedHypotheses: approved }),
  requestCancel: (scanId, ownerId) => requestScanCancel(db, ownerId, scanId),
  background: (task) => {
    void task(); // `drive` catches its own errors and logs with safe fields; never rejects
  },
  logger,
});

// Redis-backed rate-limit store when REDIS_URL is set (shared across instances, ADR-20). Without
// it, hono-rate-limiter's in-memory store is used — correct for a single instance only.
let rateLimitStore: ((prefix: string) => Store<AppEnv>) | undefined;
if (env.REDIS_URL !== undefined) {
  const redis = createRedis(env.REDIS_URL);
  const client = honoRateLimitClient(redis);
  rateLimitStore = (prefix) => new RedisStore<AppEnv>({ client, prefix: `corvid:rl:${prefix}:` });
} else {
  logger.warn('REDIS_URL not set — rate limiting is in-memory (per-process). Set REDIS_URL in prod.');
}

const app = createApp({
  auth,
  db,
  limits: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    authMax: env.AUTH_RATE_LIMIT_MAX,
    concurrentScanCap: env.CONCURRENT_SCAN_CAP,
  },
  logger,
  proofPorts,
  // Serialize then encrypt; the plaintext credentials never leave this closure or reach a log.
  encryptCredentials: (credentials) => credentialCipher.encrypt(JSON.stringify(credentials)),
  scanRuntime,
  ...(rateLimitStore !== undefined ? { rateLimitStore } : {}),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'gateway listening');
});
