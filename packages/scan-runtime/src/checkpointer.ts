import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Pool } from 'pg';

// The durable checkpointer (ADR-27): scan state is serialized to Postgres per node, so a paused
// scan (approval or OOB interrupt) survives a process/container restart and resumes days later on
// whatever process holds the scan id. Lives in its own `scan_runtime` schema, separate from the
// domain tables. We own the pool so it can be closed cleanly on shutdown.

export interface CheckpointerHandle {
  readonly checkpointer: PostgresSaver;
  close(): Promise<void>;
}

export async function createCheckpointer(connectionString: string): Promise<CheckpointerHandle> {
  const pool = new Pool({ connectionString });
  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'scan_runtime' });
  // Idempotent: creates the checkpoint tables/migrations on first use, no-ops thereafter.
  await checkpointer.setup();
  return {
    checkpointer,
    close: async () => {
      await pool.end();
    },
  };
}
