import { reportJobSchema, type ReportJob } from '@corvid/tool-contracts';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

// The durable finding fan-out (ADR-17, Unit 7). A scan entering `reporting` enqueues one
// `report.generate` job; the report-worker consumes it, generates + stores the report, and completes
// the scan. BullMQ (Redis-backed) gives the property that matters: a job survives a worker restart
// and retries on failure — killing and restarting the worker loses no report. The finding itself is
// already durable in Postgres before this enqueue (ADR-17 invariant), so the queue never holds the
// only copy of anything.

export const REPORT_QUEUE = 'corvid:reports';

/**
 * Idempotent per-scan job id. Custom BullMQ job ids must not contain `:` (its Redis key separator)
 * nor be all-digits; a uuid scanId with a `report-` prefix satisfies both. While a job with this id
 * is retained, a re-enqueue for the same scan is a no-op — so a replayed `reporting` transition
 * cannot spawn a second, concurrent report generation.
 */
export function reportJobId(scanId: string): string {
  return `report-${scanId}`;
}

export interface ReportQueue {
  /** Enqueue report generation for a scan (idempotent per scan). */
  enqueue(scanId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create the report queue producer, reusing the shared ioredis connection (BullMQ wraps it). Jobs
 * retry with exponential backoff; completed jobs are retained briefly (so the idempotent job id
 * holds and for observability), failed jobs are kept for triage.
 */
export function createReportQueue(connection: Redis): ReportQueue {
  const queue = new Queue<ReportJob>(REPORT_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: false,
    },
  });
  return {
    async enqueue(scanId: string): Promise<void> {
      await queue.add('generate', { scanId }, { jobId: reportJobId(scanId) });
    },
    async close(): Promise<void> {
      await queue.close();
    },
  };
}

/** The report-generation handler the worker runs per job (validated payload). */
export type ReportJobHandler = (job: ReportJob) => Promise<void>;

/**
 * Create the report worker. The payload is re-validated at the boundary (§1) before the handler runs
 * — a malformed job body is rejected, never acted on. Concurrency is low: report generation is an
 * LLM + PDF render, not a hot loop, and testing is sequential per scan anyway (ADR-25).
 */
export function createReportWorker(connection: Redis, handler: ReportJobHandler): Worker<ReportJob> {
  return new Worker<ReportJob>(
    REPORT_QUEUE,
    async (job: Job<ReportJob>) => {
      const data = reportJobSchema.parse(job.data);
      await handler(data);
    },
    { connection, concurrency: 2 },
  );
}
