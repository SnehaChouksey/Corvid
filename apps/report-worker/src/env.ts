import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// Report-worker configuration, validated at startup and fail-closed (§9). It consumes the durable
// BullMQ report queue (ADR-17), reads the verified findings, calls OpenRouter for the narrative, and
// renders the PDF.
//   - DATABASE_URL — verified findings + report store + the append-only audit log.
//   - REDIS_URL — the BullMQ report queue connection.
//   - OPENROUTER_API_KEY — the LLM gateway (ADR-23); the report narrative is a `report` call.
// Spend ceilings default to the conservative D-12 values in @corvid/db unless overridden here.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_REPORT_MODEL: z.string().min(1).optional(),
  LLM_GLOBAL_DAILY_CREDITS: z.coerce.number().positive().optional(),
  LLM_USER_DAILY_CREDITS: z.coerce.number().positive().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ReportWorkerEnv = z.output<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): ReportWorkerEnv {
  return parseEnv(EnvSchema, source);
}
