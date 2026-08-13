import type { CrawledParam, InjectionClass, InjectionObservation } from '@corvid/tool-contracts';

import { INJECTION_PAYLOADS, injectPayload, matchDbErrors } from './injection-payloads.ts';
import { computeSignal } from './signal.ts';
import type { NotSent, SendFn, TesterTarget } from './types.ts';

// injection.fuzz (Unit 4, D-14). Sends a baseline (un-injected) request, then each payload injected
// into the target parameter, recording the response signal per attempt and — for error-based — the
// NAMES of any matched DB-error patterns. It does NOT decide vulnerability: the verifier applies the
// FP guards (error attributable to the metacharacter vs the neutralized control; time-based
// dose-response scaling). Every request goes through http.send (scope/rate/dedup/audit).

export interface InjectionFuzzInput {
  readonly target: TesterTarget;
  readonly param: CrawledParam;
  /** Restrict to certain classes; default is all (error, time, nosqli). */
  readonly classes?: readonly InjectionClass[];
  /** Original request body, if the target takes one (used when injecting a body param). */
  readonly baseBody?: string;
}

export type InjectionOutcome = { readonly kind: 'observed'; readonly observation: InjectionObservation } | NotSent;

export async function injectionFuzz(send: SendFn, input: InjectionFuzzInput): Promise<InjectionOutcome> {
  const { target, param } = input;
  const baseReq = {
    scanId: target.scanId,
    method: target.method,
    url: target.url,
    ...(input.baseBody !== undefined ? { body: input.baseBody } : {}),
  };

  const baselineOut = await send(baseReq);
  if (baselineOut.outcome !== 'sent') return { kind: 'not_sent', reason: baselineOut.outcome };
  const baseline = computeSignal(baselineOut.response);

  const selected = INJECTION_PAYLOADS.filter(
    (p) => input.classes === undefined || input.classes.includes(p.injectionClass),
  );

  const attempts: InjectionObservation['attempts'][number][] = [];
  for (const payload of selected) {
    const injected = injectPayload(target.url, input.baseBody, param, payload.value);
    const out = await send({
      scanId: target.scanId,
      method: target.method,
      url: injected.url,
      ...(injected.body !== undefined ? { body: injected.body } : {}),
    });
    if (out.outcome !== 'sent') return { kind: 'not_sent', reason: out.outcome };

    attempts.push({
      injectionClass: payload.injectionClass,
      payloadFamily: payload.family,
      baseline,
      injected: computeSignal(out.response),
      // Only error-based attempts scan for DB-error signatures; the raw body is used transiently and
      // never stored — only the matched pattern names (§5).
      matchedErrorPatterns: payload.injectionClass === 'sqli_error' ? matchDbErrors(out.response.body) : [],
    });
  }

  return { kind: 'observed', observation: { vulnClass: 'injection', param, attempts } };
}
