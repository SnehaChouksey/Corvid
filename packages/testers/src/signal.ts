import { createHash } from 'node:crypto';

import type { HttpResponse, HttpSendOutput, ResponseSignal } from '@corvid/tool-contracts';

// Turn an http.send response into the compact, NON-SENSITIVE signal the verifier compares: status +
// size + timing + a body HASH (never the raw body — §5). A refusal/dedup carries no response, so a
// tester surfaces it rather than fabricating a signal.

export function computeSignal(response: HttpResponse): ResponseSignal {
  return {
    status: response.status,
    // Byte length (not `.length`, which counts UTF-16 code units) so a multibyte body doesn't skew
    // the size-delta discriminator the verifier reads.
    bodyLength: Buffer.byteLength(response.body, 'utf8'),
    timingMs: response.timingMs,
    bodyHash: createHash('sha256').update(response.body).digest('hex'),
  };
}

export type SignalResult =
  | { readonly ok: true; readonly signal: ResponseSignal }
  | { readonly ok: false; readonly notSent: 'refused_out_of_scope' | 'deduplicated' };

export function signalFrom(output: HttpSendOutput): SignalResult {
  if (output.outcome === 'sent') return { ok: true, signal: computeSignal(output.response) };
  return { ok: false, notSent: output.outcome };
}
