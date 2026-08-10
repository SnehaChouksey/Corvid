import type { HypothesisStatus, ScanStatus, VulnClass } from '@corvid/tool-contracts';
import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hypotheses = pgTable('hypotheses', {
  id: uuid('id').primaryKey().defaultRandom(),
  scanId: uuid('scan_id')
    .notNull()
    .references(() => scans.id, { onDelete: 'cascade' }),
  vulnClass: text('vuln_class').$type<VulnClass>().notNull(),
  endpoint: text('endpoint').notNull(),
  rationale: text('rationale').notNull(),
  // Redis dedup cache keys on this (D-10, ADR-D10).
  fingerprint: text('fingerprint').notNull(),
  status: text('status').$type<HypothesisStatus>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const findings = pgTable('findings', {
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
});

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
