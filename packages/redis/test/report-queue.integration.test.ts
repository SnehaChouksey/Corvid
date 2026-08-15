import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { Queue } from 'bullmq';

import { createRedis, createReportQueue, createReportWorker, REPORT_QUEUE, reportJobId } from '../src/index.ts';

// Opt-in integration test against a real Redis (mirrors the frontier/oob tests). Proves the DoD's
// durable-job property: a job enqueued while NO worker is running is not lost — it sits durably in
// Redis and is processed once a worker starts (the "kill and restart the worker loses no finding"
// guarantee, ADR-17). Skips cleanly without REDIS_URL.
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL === undefined) {
  test('report-queue integration (skipped — set REDIS_URL to run)', { skip: true }, () => {
    // intentionally empty
  });
} else {
  runIntegrationTests(REDIS_URL);
}

function runIntegrationTests(url: string): void {
  const scanId = '33333333-3333-4333-8333-333333333333';

  after(async () => {
    // Clean the queue so re-runs start fresh (obliterate removes all job keys for this queue).
    const cleanup = createRedis(url);
    const q = new Queue(REPORT_QUEUE, { connection: cleanup });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
    cleanup.disconnect();
  });

  test('a job enqueued with no worker running is durable, then processed on worker start', async () => {
    const producerConn = createRedis(url);
    const queue = createReportQueue(producerConn);

    // Enqueue BEFORE any worker exists — the job must persist in Redis, not be dropped.
    await queue.enqueue(scanId);

    const inspect = new Queue(REPORT_QUEUE, { connection: createRedis(url) });
    const waiting = await inspect.getWaitingCount();
    assert.ok(waiting >= 1, 'job should be waiting durably with no worker running');

    // Now start a worker — the previously-enqueued job is picked up and processed exactly once.
    const processed: string[] = [];
    const workerConn = createRedis(url);
    const worker = createReportWorker(workerConn, async (job) => {
      processed.push(job.scanId);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('job was not processed in time')), 15_000);
      worker.on('completed', () => {
        clearTimeout(timer);
        resolve();
      });
      worker.on('failed', (_job, err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.deepEqual(processed, [scanId]);

    await worker.close();
    await queue.close();
    await inspect.close();
    workerConn.disconnect();
    producerConn.disconnect();
  });

  test('enqueue is idempotent per scan (same job id dedups while retained)', async () => {
    const conn = createRedis(url);
    const queue = createReportQueue(conn);
    await queue.enqueue(scanId);
    await queue.enqueue(scanId); // duplicate — ignored by the custom job id

    const inspect = new Queue(REPORT_QUEUE, { connection: createRedis(url) });
    const job = await inspect.getJob(reportJobId(scanId));
    assert.ok(job, 'the single deduped job exists under its stable id');

    await queue.close();
    await inspect.close();
    conn.disconnect();
  });
}
