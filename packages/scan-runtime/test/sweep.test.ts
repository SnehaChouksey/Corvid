import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  OOB_TIMEOUT_MS,
  findTimedOutThreads,
  type OobSweepPorts,
  type OobWaitResume,
  type PausedOobThread,
  sweepOobTimeouts,
} from '../src/index.ts';

test('findTimedOutThreads returns only threads that reached the OOB bound (D-4)', () => {
  const now = 1_000_000;
  const threads = [
    { threadId: 'fresh', interruptedAt: now - 1_000 },
    { threadId: 'exactly', interruptedAt: now - OOB_TIMEOUT_MS },
    { threadId: 'old', interruptedAt: now - OOB_TIMEOUT_MS - 5_000 },
  ];
  // A tooling/wait timeout is a deliberate "not confirmed" resolution, never a hang.
  assert.deepEqual(findTimedOutThreads(threads, now), ['exactly', 'old']);
  assert.deepEqual(findTimedOutThreads([], now), []);
});

interface ResumeCall {
  readonly threadId: string;
  readonly resume: OobWaitResume;
}

function ports(
  threads: readonly PausedOobThread[],
  overrides: Partial<OobSweepPorts> = {},
): { ports: OobSweepPorts; resumes: ResumeCall[]; audits: string[] } {
  const resumes: ResumeCall[] = [];
  const audits: string[] = [];
  return {
    resumes,
    audits,
    ports: {
      listPausedOob: async () => threads,
      resume: async (threadId, resume) => {
        resumes.push({ threadId, resume });
      },
      audit: async (entry) => {
        audits.push(`${entry.action}:${entry.scanId}`);
      },
      ...overrides,
    },
  };
}

test('sweepOobTimeouts resumes only the timed-out threads with the timeout signal and audits each', async () => {
  const now = 1_000_000;
  const { ports: p, resumes, audits } = ports([
    { threadId: 'fresh', interruptedAt: now - 1_000 },
    { threadId: 'due', interruptedAt: now - OOB_TIMEOUT_MS - 1 },
  ]);

  const resolved = await sweepOobTimeouts(p, now);

  assert.deepEqual(resolved, ['due']);
  assert.deepEqual(resumes, [{ threadId: 'due', resume: { timedOut: true } }]);
  assert.deepEqual(audits, ['oob.timeout:due']);
});

test('a single resume failure does not abort the sweep — the rest still resolve', async () => {
  const now = 2_000_000;
  const resumes: ResumeCall[] = [];
  const p: OobSweepPorts = {
    listPausedOob: async () => [
      { threadId: 'bad', interruptedAt: now - OOB_TIMEOUT_MS - 1 },
      { threadId: 'good', interruptedAt: now - OOB_TIMEOUT_MS - 1 },
    ],
    resume: async (threadId, resume) => {
      if (threadId === 'bad') throw new Error('resume blew up');
      resumes.push({ threadId, resume });
    },
    logger: { error: () => {} },
  };

  const resolved = await sweepOobTimeouts(p, now);

  assert.deepEqual(resolved, ['good']); // 'bad' stays paused, retried next tick
  assert.deepEqual(resumes, [{ threadId: 'good', resume: { timedOut: true } }]);
});

test('an empty frontier resolves nothing', async () => {
  const { ports: p, resumes } = ports([]);
  assert.deepEqual(await sweepOobTimeouts(p, Date.now()), []);
  assert.equal(resumes.length, 0);
});
