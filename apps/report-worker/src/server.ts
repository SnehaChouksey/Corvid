import {
  appendAudit,
  createDb,
  DEFAULT_DAILY_SPEND_CEILINGS,
  getScanReportData,
  recordLlmCall,
  setScanStatus,
  sumDailyLlmSpend,
  upsertReport,
  utcDayStart,
  type SpendCeilings,
} from '@corvid/db';
import { createLogger } from '@corvid/logger';
import { createOpenRouterClient } from '@corvid/llm';
import { createRedis, createReportWorker } from '@corvid/redis';
import type { ReportContext } from '@corvid/report';

import { loadEnv } from './env.ts';
import { buildReportHandler } from './handler.ts';
import { createPlaywrightPdfRenderer } from './pdf.ts';

const REPORT_ACTOR = 'report-worker';

// Composition root: validate env (fail closed), wire dependencies, consume the durable report queue.
// Nothing here has logic beyond wiring — the handler is unit-tested with fakes (no DB/LLM/Chromium).
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'report-worker' });
  const { db, pool } = createDb(env.DATABASE_URL);

  const ceilings: SpendCeilings = {
    globalCeilingCredits: env.LLM_GLOBAL_DAILY_CREDITS ?? DEFAULT_DAILY_SPEND_CEILINGS.globalCeilingCredits,
    userCeilingCredits: env.LLM_USER_DAILY_CREDITS ?? DEFAULT_DAILY_SPEND_CEILINGS.userCeilingCredits,
  };

  const llm = createOpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    ...(env.OPENROUTER_REPORT_MODEL !== undefined ? { models: { report: env.OPENROUTER_REPORT_MODEL } } : {}),
  });

  const reportCtx: ReportContext = {
    loadData: (scanId) => getScanReportData(db, scanId),
    llm,
    ceilings,
    now: () => new Date(),
    logger,
    dailySpend: (userId, since) => sumDailyLlmSpend(db, { userId, since: since ?? utcDayStart(new Date()) }),
    recordCall: (call) => recordLlmCall(db, call),
  };

  const pdf = createPlaywrightPdfRenderer();
  const handler = buildReportHandler({
    reportCtx,
    renderPdf: (html) => pdf.render(html),
    saveReport: (input) => upsertReport(db, input),
    completeScan: (scanId) => setScanStatus(db, scanId, 'completed'),
    audit: (entry) => appendAudit(db, { ...entry, actor: REPORT_ACTOR }),
    logger,
  });

  const connection = createRedis(env.REDIS_URL);
  const worker = createReportWorker(connection, handler);
  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err_name: err instanceof Error ? err.name : 'unknown' },
      'report job failed (will retry per backoff policy)',
    );
  });
  logger.info({ queue: 'corvid:reports' }, 'report-worker listening');

  const shutdown = (signal: string): void => {
    void (async (): Promise<void> => {
      logger.info({ signal }, 'report-worker shutting down');
      await worker.close();
      await pdf.close();
      connection.disconnect();
      await pool.end();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Boot failure must be loud and fail the process. Log SAFE fields only (no raw message — it could
  // carry a connection string).
  createLogger({ level: 'error', service: 'report-worker' }).fatal(
    { err_name: err instanceof Error ? err.name : 'unknown' },
    'report-worker failed to start',
  );
  process.exit(1);
});
