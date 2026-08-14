import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// OOB listener configuration, validated at startup and fail-closed (§9). Every value here is
// safety-relevant and has no safe default, so a missing one fails the boot:
//   - OOB_HOST — the wildcard apex the listener owns (e.g. `oob.example.com`, `*.oob.example.com`
//     pointed here); the SSRF payload references `<token>.<OOB_HOST>` and a callback carries it in
//     the Host header.
//   - DATABASE_URL — the append-only audit log (ADR-16).
//   - REDIS_URL — the token ledger. REQUIRED (not optional): the listener's writes and the runtime's
//     reads must share one ledger, so an in-memory fallback would silently disable SSRF confirmation
//     in any multi-process deploy — the exact silent degradation §9 forbids.
//   - OOB_CONTROL_TOKEN — the shared bearer gating the internal control plane (register/query).
const EnvSchema = z.object({
  OOB_HOST: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OOB_CONTROL_TOKEN: z.string().min(16),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type OobListenerEnv = z.output<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): OobListenerEnv {
  return parseEnv(EnvSchema, source);
}
