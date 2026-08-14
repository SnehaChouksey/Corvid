import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// OOB listener configuration, validated at startup and fail-closed (§9). OOB_HOST is the wildcard
// apex the listener owns (e.g. `oob.example.com`, with `*.oob.example.com` pointed here): the SSRF
// payload references `<token>.<OOB_HOST>` and an inbound callback carries it in the Host header. It
// is safety-relevant and has no safe default, so a missing value fails the boot. DATABASE_URL is
// required for the audit log (ADR-16). REDIS_URL backs the token ledger across services and
// restarts; without it the store is in-memory (single instance, lost on restart) — a boot warning.
const EnvSchema = z.object({
  OOB_HOST: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type OobListenerEnv = z.output<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): OobListenerEnv {
  return parseEnv(EnvSchema, source);
}
