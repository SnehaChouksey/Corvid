import type { InjectionObservation } from '@corvid/tool-contracts';

import { DEFAULT_SEVERITY, notConfirmed, type VerifyResult } from './types.ts';

// Injection verification (D-14). Two deterministic signals, each with its own false-positive guard:
//   - Error-based: a DB-error signature on an injected metacharacter, WHILE the neutralized/escaped
//     control produces NO such error — so the error is attributable to our metacharacter, not the app.
//   - Time-based dose-response: latency must SCALE with the injected delay (a 4s sleep ≈ 2× a 2s
//     sleep, both well above the un-injected baseline). A single slow response never qualifies — this
//     is what defeats network jitter. (v1 uses one dose pair; ≥3 repeats per dose is a calibration
//     improvement that needs the tester to send repeats — tracked.)
// Boolean-differential (the third D-14 signal) is deferred with the tester's boolean payloads.
// Deterministic, no LLM.

const CONTROL_FAMILY = 'escaped-control';
const MIN_2S_DELAY_MS = 1500; // the 2s sleep must clearly fire, allowing for baseline variance
const MIN_4S_DELAY_MS = 3500;
const SCALE_LOW = 1.6; // 4s delay must be ~2× the 2s delay (jitter won't produce this)
const SCALE_HIGH = 2.4;

interface DoseResponse {
  readonly dialect: string;
  readonly delay2Ms: number;
  readonly delay4Ms: number;
}

function findDoseResponse(attempts: InjectionObservation['attempts']): DoseResponse | undefined {
  for (const dialect of ['pg-sleep', 'mysql-sleep']) {
    const a2 = attempts.find((a) => a.payloadFamily === `${dialect}-2s`);
    const a4 = attempts.find((a) => a.payloadFamily === `${dialect}-4s`);
    if (a2 === undefined || a4 === undefined) continue;
    const delay2 = a2.injected.timingMs - a2.baseline.timingMs;
    const delay4 = a4.injected.timingMs - a4.baseline.timingMs;
    const scales = delay4 >= SCALE_LOW * delay2 && delay4 <= SCALE_HIGH * delay2;
    if (delay2 >= MIN_2S_DELAY_MS && delay4 >= MIN_4S_DELAY_MS && scales) {
      return { dialect, delay2Ms: delay2, delay4Ms: delay4 };
    }
  }
  return undefined;
}

export function verifyInjection(observation: InjectionObservation): VerifyResult {
  const { attempts, param } = observation;

  // Error-based: the false-positive guard is that the neutralized control must NOT error.
  const control = attempts.find((a) => a.payloadFamily === CONTROL_FAMILY);
  const controlClean = control === undefined || control.matchedErrorPatterns.length === 0;
  const errored = attempts.find(
    (a) => a.injectionClass === 'sqli_error' && a.payloadFamily !== CONTROL_FAMILY && a.matchedErrorPatterns.length > 0,
  );
  if (errored !== undefined && controlClean) {
    return {
      kind: 'verified',
      severity: DEFAULT_SEVERITY.injection,
      proof: {
        summary: `SQLi confirmed (error-based) on parameter "${param.name}": the injected metacharacter (${errored.payloadFamily}) elicited a DB error the neutralized control did not.`,
        signals: {
          param: param.name,
          payloadFamily: errored.payloadFamily,
          matchedErrorPatterns: errored.matchedErrorPatterns.join(','),
          controlClean: true,
        },
      },
    };
  }

  // Time-based dose-response.
  const dose = findDoseResponse(attempts);
  if (dose !== undefined) {
    return {
      kind: 'verified',
      severity: DEFAULT_SEVERITY.injection,
      proof: {
        summary: `SQLi confirmed (time-based dose-response) on parameter "${param.name}": latency scaled with the injected delay (${dose.dialect}: 2s→${dose.delay2Ms}ms, 4s→${dose.delay4Ms}ms above baseline).`,
        signals: { param: param.name, dialect: dose.dialect, delay2Ms: dose.delay2Ms, delay4Ms: dose.delay4Ms },
      },
    };
  }

  return notConfirmed('no error attributable to the metacharacter (control clean) and no time-based dose-response');
}
