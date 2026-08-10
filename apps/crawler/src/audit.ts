import { appendAudit, type Database } from '@corvid/db';

import type { AuditSink, CrawlAuditEntry } from './crawl.ts';

// The crawler acts as a system actor, not a human user (ADR-16 audit actor is a users.id OR a
// system label). Every crawl start/refusal/completion is attributed to this label.
const CRAWLER_ACTOR = 'crawler';

/** AuditSink backed by @corvid/db's append-only audit log. `detail` carries only safe metadata. */
export class DbAuditSink implements AuditSink {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async append(entry: CrawlAuditEntry): Promise<void> {
    await appendAudit(this.#db, {
      scanId: entry.scanId,
      action: entry.action,
      actor: CRAWLER_ACTOR,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
  }
}
