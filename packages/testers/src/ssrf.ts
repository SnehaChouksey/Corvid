import type { CrawledParam, SsrfObservation } from '@corvid/tool-contracts';

import { injectPayload } from './injection-payloads.ts';
import type { NotSent, SendFn, TesterTarget } from './types.ts';

// ssrf.check (Unit 4, D-16). Registers a unique out-of-band token with the OOB listener, injects a
// payload URL referencing it into the target parameter, and sends. Confirmation is OUT OF BAND — a
// correlated inbound callback to the listener (Unit 5), never a socket/connect signal (E2B can
// accept-then-drop a denied egress). The tester emits only the token + whether the payload was sent;
// the verifier correlates the callback (or times out to "not confirmed", D-4).

/** Registers a per-scan OOB token with the listener; the real one lands in Unit 5, a fake in tests. */
export interface OobRegistrar {
  register(scanId: string): Promise<{ token: string; host: string }>;
}

export interface SsrfCheckInput {
  readonly target: TesterTarget;
  readonly param: CrawledParam;
  readonly baseBody?: string;
}

export type SsrfOutcome = { readonly kind: 'observed'; readonly observation: SsrfObservation } | NotSent;

export async function ssrfCheck(send: SendFn, oob: OobRegistrar, input: SsrfCheckInput): Promise<SsrfOutcome> {
  const { target, param } = input;
  const { token, host } = await oob.register(target.scanId);
  // A DNS/HTTP callback to `<token>.<oob-host>` uniquely identifies THIS test when it fires.
  const payloadUrl = `http://${token}.${host}/`;

  const injected = injectPayload(target.url, input.baseBody, param, payloadUrl);
  if (!injected.ok) return { kind: 'not_sent', reason: 'unsupported', detail: injected.reason };
  const out = await send({
    scanId: target.scanId,
    method: target.method,
    url: injected.url,
    ...(injected.body !== undefined ? { body: injected.body } : {}),
  });

  // The request to the target endpoint is what http.send scopes; the OOB URL is only a param value.
  // A refusal/dedup means the payload didn't go out this run — reflected as sent:false.
  return {
    kind: 'observed',
    observation: { vulnClass: 'ssrf', param, oobToken: token, sent: out.outcome === 'sent' },
  };
}
