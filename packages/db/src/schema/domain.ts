import type { HypothesisPlan, HypothesisStatus, ScanStatus, VulnClass } from '@corvid/tool-contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.ts';

// Domain tables (`02` §5). Every row is owner-scoped: `targets`/`scans` carry `owner_id`;
// `hypotheses`/`findings`/`audit_log` are scoped transitively through their scan. Status and
// vuln-class columns are typed with the discriminated unions from @corvid/tool-contracts so an
// invalid state is a type error, not a free-text string. DB columns stay snake_case (§11).

export const targets = pgTable('targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  // Validated by @corvid/scope at the service layer (kept decoupled here); stored as the raw
  // scope-rules object.
  scopeRules: jsonb('scope_rules').$type<Record<string, unknown>>().notNull(),
  // Null until authorization is recorded with proof-of-control (D-7). Editing scope clears both.
  authorizationConfirmedAt: timestamp('authorization_confirmed_at', { withTimezone: true }),
  authorizedBy: text('authorized_by'),
  proofOfControl: jsonb('proof_of_control').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scans = pgTable('scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id')
    .notNull()
    .references(() => targets.id, { onDelete: 'cascade' }),
  status: text('status').$type<ScanStatus>().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // The LangGraph thread id (= scan id); the durable checkpointer keys on it (ADR-27).
  workflowId: text('workflow_id'),
  // Analyst-supplied target credentials (D-1, ADR-D1), ENCRYPTED at rest (@corvid/crypto,
  // AES-256-GCM). The plaintext is a `ScanCredentials` JSON; it is decrypted only transiently at use
  // by the crawler/testers (`02` §7) and NEVER logged (§5). Null = no credentials (unauthenticated
  // surface only). Opaque ciphertext here — the DB layer never sees plaintext.
  credentialsEncrypted: text('credentials_encrypted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hypotheses = pgTable(
  'hypotheses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    vulnClass: text('vuln_class').$type<VulnClass>().notNull(),
    endpoint: text('endpoint').notNull(),
    rationale: text('rationale').notNull(),
    // Redis dedup cache keys on this (D-10, ADR-D10); the unique index below is the durable dedup.
    fingerprint: text('fingerprint').notNull(),
    status: text('status').$type<HypothesisStatus>().notNull(),
    // Structured test plan (method/param/payload family; extended by the plan node + Unit 4/5 with
    // the concrete tool/payload/intended payload shown at the approval gate, `02` §6). Validated at
    // the service layer (agent core) via `hypothesisPlanSchema`; stored typed here.
    plan: jsonb('plan').$type<HypothesisPlan>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Durable per-scan dedup (D-10/ADR-D10): a hypothesize node that re-runs on resume (ADR-27)
    // upserts with onConflictDoNothing on this key, so a replay never double-inserts.
    uniqueIndex('hypotheses_scan_id_fingerprint_key').on(table.scanId, table.fingerprint),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hypothesisId: uuid('hypothesis_id')
      .notNull()
      .references(() => hypotheses.id, { onDelete: 'cascade' }),
    vulnClass: text('vuln_class').$type<VulnClass>().notNull(),
    payload: text('payload').notNull(),
    proof: text('proof').notNull(),
    // The single gate the Report Writer checks — no other field admits a finding to a report.
    verified: boolean('verified').notNull().default(false),
    // CVSS 3.1 base score + vector (D-3, ADR-D3); the Critical/High band is derived at read time.
    severity: text('severity'),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One verified finding per hypothesis. The verify node re-runs on resume (ADR-27), so it upserts
    // with onConflictDoNothing on this key — a replay never double-inserts the same finding.
    uniqueIndex('findings_hypothesis_id_key').on(table.hypothesisId),
    // The findings store holds VERIFIED findings only (ADR-05) — the single gate the report writer
    // checks. Make that structural, not call-site vigilance (§5): the DB rejects a verified=false row.
    check('findings_verified_true', sql`${table.verified} = true`),
  ],
);

// Append-only accountability record (ADR-16). A structural UPDATE/DELETE block is added in a
// migration; the repo layer exposes insert + read only. `scan_id` uses a plain FK (no delete
// action) — a scan with audit history can't be hard-deleted, which is the point: history outlives
// the scan. It is nullable for platform-level events (e.g. auth) that aren't tied to a scan.
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  scanId: uuid('scan_id').references(() => scans.id),
  action: text('action').notNull(),
  // The acting identity: a `users.id` for a human action, or an agent/system actor label.
  actor: text('actor').notNull(),
  detail: text('detail'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
});

// Per-call LLM spend ledger (ADR-21). Each hypothesize/report LLM call writes one row at the call
// site; the daily hard-stop (global + per-user, D-12) sums these rows for the current UTC day — the
// kill-switch reads the same rows it writes, so there is no separate meter to drift. Not in the
// original §5 ERD: this table implements ADR-21's "record cost at the call site".
//
// `user_id` is denormalized (not only reachable via scan → owner) so the per-user cap is a direct
// sum and a scan deletion can't erase a user's spend. `scan_id`/`user_id` are plain FKs (no cascade)
// — like `audit_log`, spend history is accounting that outlives the scan.
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Which reasoning call site (ADR-23). Inline union keeps @corvid/db decoupled from @corvid/llm.
    purpose: text('purpose').$type<'hypothesize' | 'report'>().notNull(),
    // Resolved model slug, for per-model cost analysis in Unit 8. Not a secret.
    model: text('model').notNull(),
    // OpenRouter `usage.cost` in credits. NULL when the gateway didn't report it — e.g. BYOK, where
    // upstream inference is billed to the provider key, so the credit cap under-counts BYOK (tracked).
    costCredits: numeric('cost_credits', { precision: 12, scale: 6 }),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    isByok: boolean('is_byok').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Daily rollups: global by day, and per-user by day.
    index('llm_calls_created_at_idx').on(table.createdAt),
    index('llm_calls_user_created_at_idx').on(table.userId, table.createdAt),
  ],
);
