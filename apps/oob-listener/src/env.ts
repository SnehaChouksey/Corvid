import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// OOB listener configuration, validated at startup and fail-closed (§9). Every value here is
// safety-relevant and has no safe default, so a missing one fails the boot:
//   - OOB_HOST — the single public host the listener is reachable at (e.g. `abc123.ngrok-free.app` or
//     `oob.example.com`). Path-token scheme (ADR-36): a callback is `<base>/<token>` on this host, so
//     NO wildcard DNS is needed. Used to derive the default public base and for logging.
//   - OOB_PUBLIC_BASE — optional; the full public base URL (scheme+host) the SSRF payload embeds, e.g.
//     `https://abc123.ngrok-free.app`. Set it when the listener is fronted by TLS (a tunnel/PaaS);
//     defaults to `http://<OOB_HOST>` for a plain-HTTP box. Trailing slash is trimmed.
//   - DATABASE_URL — the append-only audit log (ADR-16).
//   - REDIS_URL — the token ledger. REQUIRED (not optional): the listener's writes and the runtime's
//     reads must share one ledger, so an in-memory fallback would silently disable SSRF confirmation
//     in any multi-process deploy — the exact silent degradation §9 forbids.
//   - OOB_CONTROL_TOKEN — the shared bearer gating the internal control plane (register/query).
const EnvSchema = z.object({
  OOB_HOST: z.string().min(1),
  OOB_PUBLIC_BASE: z.url().optional(),
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

/** The public base URL the payload embeds: explicit OOB_PUBLIC_BASE, else `http://<OOB_HOST>`. */
export function resolvePublicBase(env: OobListenerEnv): string {
  return (env.OOB_PUBLIC_BASE ?? `http://${env.OOB_HOST}`).replace(/\/+$/, '');
}
