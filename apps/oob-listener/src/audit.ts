import { appendAudit, type Database } from '@corvid/db';

import type { AuditSink, OobAuditEntry } from './app.ts';

// The listener acts as a system actor, not a human user (ADR-16: the audit actor is a users.id OR a
// system label). Every token registration and every correlated inbound callback is attributed here.
const OOB_ACTOR = 'oob-listener';

/** AuditSink backed by @corvid/db's append-only audit log. `detail` carries only safe metadata. */
export class DbAuditSink implements AuditSink {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async append(entry: OobAuditEntry): Promise<void> {
    await appendAudit(this.#db, {
      scanId: entry.scanId,
      action: entry.action,
      actor: OOB_ACTOR,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
  }
}
