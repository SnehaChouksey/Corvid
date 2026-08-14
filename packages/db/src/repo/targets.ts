import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { targets } from '../schema/domain.ts';

export type TargetRow = typeof targets.$inferSelect;
export type NewTarget = typeof targets.$inferInsert;

// Every read is scoped by owner_id in the WHERE clause — tenant isolation lives in the data layer,
// never in a caller/UI check (ADR-19, CODING_STANDARDS §5). A not-owned target returns `undefined`,
// which the gateway renders as 404 (not 403) so existence isn't leaked cross-tenant.

export async function getTargetForOwner(
  db: Database,
  ownerId: string,
  targetId: string,
): Promise<TargetRow | undefined> {
  const rows = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.ownerId, ownerId)))
    .limit(1);
  return rows[0];
}

export async function listTargetsForOwner(db: Database, ownerId: string): Promise<TargetRow[]> {
  return db
    .select()
    .from(targets)
    .where(eq(targets.ownerId, ownerId))
    .orderBy(desc(targets.createdAt));
}

export async function createTarget(db: Database, target: NewTarget): Promise<TargetRow> {
  const rows = await db.insert(targets).values(target).returning();
  const row = rows[0];
  if (row === undefined) {
    // insert...returning always yields the row; a missing row means a driver/contract break.
    throw new Error('createTarget: insert returned no row');
  }
  return row;
}

export interface TargetPatch {
  readonly url?: string;
  readonly scopeRules?: Record<string, unknown>;
}

/**
 * Owner-scoped edit of a target's URL and/or scope rules. Any change to either INVALIDATES a prior
 * authorization (`01` §3, §50): widening scope must never inherit an old approval, so the
 * proof-of-control triplet (`authorization_confirmed_at`, `authorized_by`, `proof_of_control`) is
 * cleared whenever url or scope changes and re-earned via the D-7 flow. Returns the updated row, or
 * undefined if not owned (rendered 404, never 403 — ADR-19).
 */
export async function updateTargetForOwner(
  db: Database,
  ownerId: string,
  targetId: string,
  patch: TargetPatch,
): Promise<TargetRow | undefined> {
  const invalidatesAuth = patch.url !== undefined || patch.scopeRules !== undefined;
  const rows = await db
    .update(targets)
    .set({
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.scopeRules !== undefined ? { scopeRules: patch.scopeRules } : {}),
      ...(invalidatesAuth
        ? { authorizationConfirmedAt: null, authorizedBy: null, proofOfControl: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(targets.id, targetId), eq(targets.ownerId, ownerId)))
    .returning();
  return rows[0];
}

/**
 * Store the proof-of-control artifact WITHOUT stamping authorization — the pending challenge issued
 * by the D-7 flow, held until the user places it and Corvid verifies. `proof` is an opaque
 * `Record<string, unknown>` here (the proof-of-control package owns its shape); the DB stays
 * decoupled. Owner-scoped; returns undefined if not owned.
 */
export async function setTargetProofOfControl(
  db: Database,
  ownerId: string,
  targetId: string,
  proof: Record<string, unknown>,
): Promise<TargetRow | undefined> {
  const rows = await db
    .update(targets)
    .set({ proofOfControl: proof, updatedAt: new Date() })
    .where(and(eq(targets.id, targetId), eq(targets.ownerId, ownerId)))
    .returning();
  return rows[0];
}

/**
 * Stamp a target as authorized once proof-of-control is verified (D-7): records `authorized_by`
 * (the acting user's id — ADR-19) and the timestamp, and stores the verified proof. This is the
 * exact record the workflow and sandbox check before any active testing (`02` §7). Owner-scoped.
 */
export async function confirmTargetAuthorization(
  db: Database,
  ownerId: string,
  targetId: string,
  params: { readonly authorizedBy: string; readonly proofOfControl: Record<string, unknown> },
): Promise<TargetRow | undefined> {
  const rows = await db
    .update(targets)
    .set({
      authorizationConfirmedAt: new Date(),
      authorizedBy: params.authorizedBy,
      proofOfControl: params.proofOfControl,
      updatedAt: new Date(),
    })
    .where(and(eq(targets.id, targetId), eq(targets.ownerId, ownerId)))
    .returning();
  return rows[0];
}
