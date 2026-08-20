import { lookup, resolveTxt } from 'node:dns/promises';
import { readFileSync } from 'node:fs';

import {
  createHypothesizeContext,
  createPlanContext,
  hypothesize,
  plan,
} from '@corvid/agent-core';
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
import { createOpenRouterClient } from '@corvid/llm';
import { createLogger } from '@corvid/logger';
import { createE2bSandboxFactory } from '@corvid/sandbox';
import type { ProofPorts } from '@corvid/proof-of-control';
import {
  createRedis,
  createReportQueue,
  honoRateLimitClient,
  HypothesisDedup,
  type ReportQueue,
} from '@corvid/redis';
import {
  buildScanGraph,
  createCheckpointer,
  createScanRuntimeService,
  type ScanGraphDeps,
} from '@corvid/scan-runtime';
import { scanCredentialsSchema } from '@corvid/tool-contracts';
import { serve } from '@hono/node-server';
import { RedisStore, type Store } from 'hono-rate-limiter';

import { type AppEnv, createApp } from './app.ts';
import { createCrawlPort, resolveCrawlerEntry } from './crawl-port.ts';
import { loadEnv } from './env.ts';
import { createObservePort, resolveBurstBundlePath } from './observe-port.ts';

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

// Report fan-out (ADR-17/ADR-34): when a scan enters `reporting`, enqueue a durable BullMQ job that
// the report-worker consumes to generate + store the report and complete the scan. Requires Redis;
// without it, the fan-out is disabled and a scan that reaches `reporting` waits for a worker (which
// only exists once live testing is wired, Unit 0/8) — surfaced as a warning, never a silent no-op.
let reportQueue: ReportQueue | undefined;
if (env.REDIS_URL !== undefined) {
  reportQueue = createReportQueue(createRedis(env.REDIS_URL, logger));
} else {
  logger.warn('REDIS_URL not set — report fan-out disabled; a scan reaching "reporting" will not auto-generate a report');
}
const notLive = (op: string): never => {
  throw new InfraError(`scan-runtime dep '${op}' is not wired yet (live testing is Unit 0/8)`, {
    retryable: false,
  });
};

// ── Reasoning ports (Phase 2, slab 1): wire hypothesize + plan when the LLM + Redis are present ────
// The reasoning core needs OpenRouter (ADR-23) and a Redis for the per-scan hypothesis dedup cache
// (the DB unique index is the durable authority; the cache is only the fast path). Without either,
// these ports fall back to notLive so a started scan fails fast and audibly, never half-running.
const runtimeRedis = env.REDIS_URL !== undefined ? createRedis(env.REDIS_URL, logger) : undefined;
const llm =
  env.OPENROUTER_API_KEY !== undefined
    ? createOpenRouterClient({ apiKey: env.OPENROUTER_API_KEY }, { logger })
    : undefined;

let hypothesizePort: ScanGraphDeps['hypothesize'];
let planPort: ScanGraphDeps['plan'];
if (llm !== undefined && runtimeRedis !== undefined) {
  const hypothesizeCtx = createHypothesizeContext({
    db,
    llm,
    dedupFor: (scanId) => new HypothesisDedup(runtimeRedis, scanId),
    logger,
  });
  const planCtx = createPlanContext({ db, logger });
  hypothesizePort = (input) => hypothesize(hypothesizeCtx, input);
  planPort = (scanId) => plan(planCtx, scanId);
} else {
  logger.warn(
    'reasoning not wired (needs OPENROUTER_API_KEY + REDIS_URL) — a started scan will fail fast at hypothesize',
  );
  hypothesizePort = async () => notLive('hypothesize');
  planPort = async () => notLive('plan');
}

// ── Crawl port (Phase 2, slab 2): invoke the crawler MCP server as a subprocess (option A) ────────
// The crawler needs a Redis frontier; without REDIS_URL (or if its entry can't be resolved) crawl
// falls back to notLive so a started scan fails fast rather than silently mapping nothing.
let crawlPort: ScanGraphDeps['crawl'];
if (env.REDIS_URL !== undefined) {
  try {
    crawlPort = createCrawlPort({
      entryPath: resolveCrawlerEntry(),
      env: { DATABASE_URL: env.DATABASE_URL, REDIS_URL: env.REDIS_URL, LOG_LEVEL: env.LOG_LEVEL },
      logger,
    });
  } catch (err) {
    logger.warn({ err }, 'crawler entry not resolvable — crawl not wired; a started scan will fail fast at crawl');
    crawlPort = async () => notLive('crawl');
  }
} else {
  logger.warn('REDIS_URL not set — crawl not wired (crawler needs the frontier); a started scan will fail fast at crawl');
  crawlPort = async () => notLive('crawl');
}

// ── Observe port (Phase 2, slab 3c): run the testing burst inside a per-burst E2B sandbox ─────────
// Needs the E2B key (the sandbox) — without it, observe fails fast so a scan never "tests" without the
// egress-restricted sandbox that is the whole safety model (ADR-22). OOB is all-or-nothing: with all
// three OOB vars, blind-SSRF confirmation is enabled; without them, SSRF hypotheses are skipped.
let observePort: ScanGraphDeps['observe'];
if (env.E2B_API_KEY !== undefined) {
  const oob =
    env.OOB_HOST !== undefined && env.OOB_REGISTER_URL !== undefined && env.OOB_CONTROL_TOKEN !== undefined
      ? { host: env.OOB_HOST, registerUrl: env.OOB_REGISTER_URL, controlToken: env.OOB_CONTROL_TOKEN }
      : undefined;
  observePort = createObservePort({
    db,
    sandboxFactory: createE2bSandboxFactory(env.E2B_API_KEY),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a trusted package resolve (@corvid/burst-runner/bundle), never user input
    bundle: readFileSync(resolveBurstBundlePath(), 'utf8'),
    // Decrypt + validate transiently; the plaintext never leaves this closure or reaches a log (§5).
    decrypt: (ciphertext) => scanCredentialsSchema.parse(JSON.parse(credentialCipher.decrypt(ciphertext))),
    ...(oob !== undefined ? { oob } : {}),
    logger,
  });
} else {
  logger.warn('E2B_API_KEY not set — observe not wired; a started scan will fail fast at the testing burst');
  observePort = async () => notLive('observe');
}

const graphDeps: ScanGraphDeps = {
  crawl: crawlPort,
  hypothesize: hypothesizePort,
  plan: planPort,
  observe: observePort,
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
  persistStatus: async (scanId, status) => {
    await setScanStatus(db, scanId, status);
    // Enqueue the durable report job AFTER the status is persisted (idempotent per scan), so the
    // worker's later `completed` write never races ahead of this `reporting` write (ADR-34). An
    // enqueue failure is logged (safe fields only), never thrown — the status is already committed.
    if (status === 'reporting' && reportQueue !== undefined) {
      try {
        await reportQueue.enqueue(scanId);
      } catch (err) {
        logger.error(
          { scanId, err_name: err instanceof Error ? err.name : 'unknown' },
          'failed to enqueue report job (scan will remain in reporting until re-triggered)',
        );
      }
    }
  },
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
  const redis = createRedis(env.REDIS_URL, logger);
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
