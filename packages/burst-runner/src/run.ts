import {
  createHttpSend,
  DEFAULT_RATE_CONFIG,
  type FetchRequest,
  type HttpSendPorts,
} from '@corvid/http-send/core';
import { parseScopeRules } from '@corvid/scope';
import {
  idorCompare,
  injectionFuzz,
  jwtMutateTest,
  ssrfCheck,
  type OobRegistrar,
  type SendFn,
} from '@corvid/testers';
import type {
  BurstHypothesis,
  BurstInput,
  BurstOutput,
  HttpResponse,
  TesterObservation,
} from '@corvid/tool-contracts';

import { realFetch } from './fetch.ts';

// The testing-burst runner. This runs INSIDE the egress-restricted E2B sandbox (ADR-08/22): every
// payload leaves via the sandbox's own `fetch`, bounded by the firewall to target + OOB. It composes
// @corvid/http-send (the single choke point) with IN-MEMORY ports — the sandbox has no DB/Redis
// reachability, so scope is passed in (re-validated here), dedup is per-burst, and audits are
// collected into the output for the gateway to persist. The testers emit observations only; the
// deterministic gate (@corvid/verify) runs later in the gateway, never here (§8, ADR-01).

export interface BurstDeps {
  /** Network send; defaults to the sandbox's real fetch. Injected as a fake in unit tests. */
  readonly fetchImpl?: (req: FetchRequest) => Promise<HttpResponse>;
  /** OOB token registration for SSRF; defaults to an HTTP call to the control plane in `input.oob`. */
  readonly oobRegister?: OobRegistrar['register'];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Build an OOB registrar that mints a token from the listener control plane (bearer-authed). */
function httpOobRegister(oob: NonNullable<BurstInput['oob']>): OobRegistrar['register'] {
  return async (scanId: string) => {
    const res = await fetch(oob.registerUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${oob.controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scanId }),
    });
    if (!res.ok) throw new Error(`oob_register_http_${res.status}`);
    const data = (await res.json()) as { token?: unknown; host?: unknown };
    if (typeof data.token !== 'string' || typeof data.host !== 'string') {
      throw new Error('oob_register_bad_response');
    }
    return { token: data.token, host: data.host };
  };
}

/**
 * Rewrite the last purely-numeric path segment of a URL (the enumerable object id an IDOR rides on),
 * e.g. `/api/orders/7` → `/api/orders/6`. Returns null when there is no numeric segment (a non-id
 * URL), so the caller omits the derived control and the verifier safely declines to confirm.
 */
function withLastNumericSegment(rawUrl: string, replace: (n: number) => number): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg !== undefined && /^\d+$/.test(seg)) {
      segments[i] = String(replace(Number(seg)));
      url.pathname = segments.join('/');
      return url.toString();
    }
  }
  return null;
}

/** Dispatch one approved hypothesis to its tester, returning the observation (or null when unsent). */
async function runOne(
  send: SendFn,
  input: BurstInput,
  h: BurstHypothesis,
  deps: BurstDeps,
): Promise<TesterObservation | null> {
  const target = { scanId: input.scanId, url: h.url, method: h.method };
  const creds = input.credentials;

  switch (h.vulnClass) {
    case 'jwt': {
      // Needs the analyst's sample JWT (D-1); without it the forgeries can't be built.
      if (creds?.jwtSample === undefined) return null;
      const outcome = await jwtMutateTest(send, { target, sampleJwt: creds.jwtSample });
      return outcome.kind === 'observed' ? outcome.observation : null;
    }
    case 'injection': {
      if (h.param === undefined) return null;
      const outcome = await injectionFuzz(send, { target, param: h.param });
      return outcome.kind === 'observed' ? outcome.observation : null;
    }
    case 'idor': {
      // Needs two labeled sessions at different privilege (D-15). secondary = lower privilege.
      if (creds?.idorSessions === undefined) return null;
      // D-15 controls, derived from the target's numeric object id (the enumerable reference the IDOR
      // rides on): a DIFFERENT valid id for the self control, and a clearly non-existent id for the
      // absent control. The unauth control (target with no session) is always sent. When the id is not
      // a plain number these stay undefined and the verifier declines to confirm (fail safe, no FP).
      const ownResourceUrl = withLastNumericSegment(h.url, (n) => (n > 1 ? n - 1 : n + 1));
      const absentResourceUrl = withLastNumericSegment(h.url, () => 2147483647);
      const outcome = await idorCompare(send, {
        target,
        lowPrivilege: { headers: creds.idorSessions.secondary.headers },
        highPrivilege: { headers: creds.idorSessions.primary.headers },
        unauthControl: true,
        ...(ownResourceUrl !== null ? { ownResourceUrl } : {}),
        ...(absentResourceUrl !== null ? { absentResourceUrl } : {}),
      });
      return outcome.kind === 'observed' ? outcome.observation : null;
    }
    case 'ssrf': {
      if (h.param === undefined) return null;
      const register =
        deps.oobRegister ?? (input.oob !== undefined ? httpOobRegister(input.oob) : undefined);
      if (register === undefined) return null; // no OOB control plane → SSRF cannot be tested
      const outcome = await ssrfCheck(send, { register }, { target, param: h.param });
      return outcome.kind === 'observed' ? outcome.observation : null;
    }
  }
}

export async function runBurst(input: BurstInput, deps: BurstDeps = {}): Promise<BurstOutput> {
  // Re-validate the passed scope with the ONE authoritative validator (dangerous-host reject, fail
  // closed) — defense in depth even though the gateway already validated it before shipping (§9).
  const scope = parseScopeRules(input.scope);
  const audits: BurstOutput['audits'] = [];
  const sent = new Set<string>(); // per-burst dedup (the durable dedup is the gateway's concern)

  const ports: HttpSendPorts = {
    resolveTarget: async () => ({ scope, authorized: true }),
    alreadySent: async (_scanId, key) => sent.has(key),
    markSent: async (_scanId, key) => {
      sent.add(key);
    },
    fetch: deps.fetchImpl ?? realFetch,
    audit: async (entry) => {
      audits.push({
        scanId: entry.scanId,
        action: entry.action,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      });
    },
    config: DEFAULT_RATE_CONFIG,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  };

  const sender = createHttpSend(ports);
  const send: SendFn = sender.send.bind(sender);

  const observations: BurstOutput['observations'] = [];
  const errors: BurstOutput['errors'] = [];
  for (const h of input.hypotheses) {
    try {
      observations.push({ hypothesisId: h.hypothesisId, observation: await runOne(send, input, h, deps) });
    } catch (err) {
      // A single hypothesis's tooling failure must not abort the burst. Record it as an ERROR (safe
      // name only, §5) — never a fabricated signal — and give it a null observation so it yields no
      // finding (a tooling error is never a clean negative, §4; the analyst sees the recorded error).
      errors.push({ hypothesisId: h.hypothesisId, error: err instanceof Error ? err.name : 'unknown' });
      observations.push({ hypothesisId: h.hypothesisId, observation: null });
    }
  }

  return { observations, audits, errors };
}
