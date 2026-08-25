import { fileURLToPath } from 'node:url';

import {
  appendAudit,
  getScanCredentialsEncrypted,
  getTargetForScan,
  type Database,
  type HypothesisRow,
  listHypothesesForScan,
} from '@corvid/db';
import { InfraError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import type { ScanGraphDeps } from '@corvid/scan-runtime';
import { createTestingSandbox, type SandboxFactory } from '@corvid/sandbox';
import { parseScopeRules } from '@corvid/scope';
import {
  type BurstHypothesis,
  type BurstInput,
  type BurstOutput,
  burstOutputSchema,
  type ScanCredentials,
} from '@corvid/tool-contracts';

// The `observe` graph port (Unit 8 Phase 2, slab 3c): the act + observe step. It loads the scan's
// target/scope/authorization + approved hypotheses (with plans) + decrypted credentials, ships the
// bundled burst runner into a per-burst egress-restricted E2B sandbox (ADR-22), runs it, and returns
// the testers' OBSERVATIONS (the deterministic gate decides verified later, §8/ADR-01). Every payload
// leaves from INSIDE the sandbox firewall — the gateway process never sends one. Sandbox in/out is
// JSON files + stdout markers; collected http.send audits are persisted here (safe fields only, §5).

// Must match @corvid/burst-runner/src/markers.ts (the bundle wraps its output in these). Duplicated
// here rather than importing the runner's JS, so the gateway never loads the runner's runtime code.
const BURST_OUTPUT_BEGIN = '__CORVID_BURST_BEGIN__';
const BURST_OUTPUT_END = '__CORVID_BURST_END__';

export interface ObservePortDeps {
  readonly db: Database;
  readonly sandboxFactory: SandboxFactory;
  /** The burst runner bundle source, read once at startup and written into each sandbox. */
  readonly bundle: string;
  /** Decrypt + validate the scan's credentials ciphertext transiently (never logged, §5). */
  readonly decrypt: (ciphertext: string) => ScanCredentials;
  /** OOB coordinates for SSRF (host on the egress allow-list; control plane to mint tokens). */
  readonly oob?: { readonly host: string; readonly registerUrl: string; readonly controlToken: string };
  readonly logger: CorvidLogger;
  readonly sandboxTimeoutMs?: number;
}

/**
 * The `endpoint` column is stored as "METHOD url" (a display convention, e.g. "POST https://…/api").
 * The burst runner's http.send needs the BARE url — passing the whole string makes `new URL()` throw,
 * which reads as out-of-scope and silently refuses every payload. Strip the leading method token, but
 * only when the tail is a valid absolute URL, so a bare-url endpoint still works.
 */
function endpointUrl(endpoint: string): string {
  const spaceIdx = endpoint.indexOf(' ');
  if (spaceIdx === -1) return endpoint;
  const tail = endpoint.slice(spaceIdx + 1).trim();
  try {
    new URL(tail);
    return tail;
  } catch {
    return endpoint;
  }
}

/** Flatten a persisted hypothesis + its plan into a burst hypothesis; null when it has no plan. */
function toBurstHypothesis(row: HypothesisRow): BurstHypothesis | null {
  const plan = row.plan;
  if (plan === null) return null;
  return {
    hypothesisId: row.id,
    vulnClass: row.vulnClass,
    url: endpointUrl(row.endpoint),
    method: plan.method,
    ...(plan.param !== undefined ? { param: plan.param } : {}),
    payloadFamily: plan.payloadFamily,
    ...(plan.intendedPayload !== undefined ? { intendedPayload: plan.intendedPayload } : {}),
  };
}

/** Extract + validate the BurstOutput from the runner's marker-wrapped stdout. */
function extractOutput(stdout: string): BurstOutput | null {
  const start = stdout.indexOf(BURST_OUTPUT_BEGIN);
  const end = stdout.indexOf(BURST_OUTPUT_END);
  if (start === -1 || end === -1 || end < start) return null;
  const json = stdout.slice(start + BURST_OUTPUT_BEGIN.length, end);
  try {
    const parsed = burstOutputSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createObservePort(deps: ObservePortDeps): ScanGraphDeps['observe'] {
  return async (scanId, hypothesisIds) => {
    const approved = new Set(hypothesisIds);
    const target = await getTargetForScan(deps.db, scanId);
    if (target === undefined) {
      throw new InfraError('observe: scan/target not found', { retryable: false });
    }
    const scope = parseScopeRules(target.scopeRules);

    // Approved hypotheses → burst hypotheses; those without a plan can't be tested (null observation).
    const rows = (await listHypothesesForScan(deps.db, scanId)).filter((r) => approved.has(r.id));
    const hypotheses: BurstHypothesis[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const bh = toBurstHypothesis(row);
      if (bh === null) skipped.push(row.id);
      else hypotheses.push(bh);
    }

    // Decrypt analyst credentials transiently (D-1) — the plaintext stays in this closure, never logged.
    const ciphertext = await getScanCredentialsEncrypted(deps.db, scanId);
    const credentials: ScanCredentials | null =
      ciphertext !== null && ciphertext !== undefined ? deps.decrypt(ciphertext) : null;

    const burstInput: BurstInput = {
      scanId,
      scope: {
        hosts: [...scope.hosts],
        ...(scope.includePaths !== undefined ? { includePaths: [...scope.includePaths] } : {}),
        ...(scope.excludePaths !== undefined ? { excludePaths: [...scope.excludePaths] } : {}),
      },
      credentials,
      hypotheses,
      ...(deps.oob !== undefined
        ? { oob: { registerUrl: deps.oob.registerUrl, controlToken: deps.oob.controlToken } }
        : {}),
    };

    // Layer 1 (authz assert) + layer 2 (egress allow-list) are both derived from the SAME scope here
    // (ADR-03/08); createTestingSandbox refuses before touching E2B if authorization isn't recorded.
    const sandbox = await createTestingSandbox(deps.sandboxFactory, {
      scope,
      oob: { host: deps.oob?.host ?? 'oob.invalid' },
      authorization: { confirmedAt: target.authorizationConfirmedAt },
      ...(deps.sandboxTimeoutMs !== undefined ? { timeoutMs: deps.sandboxTimeoutMs } : {}),
    });

    try {
      await sandbox.writeFile('/home/user/bundle.cjs', deps.bundle);
      await sandbox.writeFile('/home/user/burst-input.json', JSON.stringify(burstInput));
      const result = await sandbox.run('node /home/user/bundle.cjs /home/user/burst-input.json');
      const output = extractOutput(result.stdout);
      if (output === null) {
        // A burst that produced no parseable output is a tooling failure, never a clean negative (§4).
        throw new InfraError('observe: burst produced no parseable output', { retryable: false });
      }

      // Persist the http.send audits collected inside the sandbox (ADR-16; safe metadata only, §5).
      for (const a of output.audits) {
        await appendAudit(deps.db, {
          scanId: a.scanId,
          action: a.action,
          actor: 'http.send',
          ...(a.detail !== undefined ? { detail: a.detail } : {}),
        });
      }
      // Record per-hypothesis tooling errors as audit notes — an error is never a silent clean negative.
      for (const e of output.errors) {
        await appendAudit(deps.db, {
          scanId,
          action: 'test.error',
          actor: 'burst-runner',
          detail: `hypothesis=${e.hypothesisId} error=${e.error}`,
        });
      }

      // Burst observations + a null observation for each approved-but-unplanned hypothesis.
      return [...output.observations, ...skipped.map((id) => ({ hypothesisId: id, observation: null }))];
    } finally {
      await sandbox.kill().catch((err: unknown) => {
        deps.logger.warn({ err }, 'observe: sandbox kill failed (already gone?)');
      });
    }
  };
}

/** Resolve the built burst runner bundle path (@corvid/burst-runner/bundle → a filesystem path). */
export function resolveBurstBundlePath(): string {
  return fileURLToPath(import.meta.resolve('@corvid/burst-runner/bundle'));
}
