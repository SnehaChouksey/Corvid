import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
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

/**
 * Apply all pending migrations. The migrations folder ships beside the built package, so the path
 * resolves whether running from `src` or `dist`. Used at boot and by integration tests.
 */
export async function runMigrations(handle: DbHandle): Promise<void> {
  // `fileURLToPath`, not `.pathname`: on Windows `.pathname` yields a leading-slash `/D:/…` path that
  // `path.join` inside the migrator mangles to `\D:\…`, so the journal isn't found (cross-platform).
  const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
  await migrate(handle.db, { migrationsFolder });
}
