import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly pool: Pool;
}

/**
 * Open a connection pool and a typed Drizzle client. One pool per long-lived service; call
 * `pool.end()` on shutdown. The connection string is validated upstream by @corvid/config (§9).
 */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
