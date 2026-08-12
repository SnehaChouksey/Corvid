import {
  perceive,
  type HypothesizeInput,
  type HypothesizeOutcome,
  type PlanOutcome,
} from '@corvid/agent-core';
import type { CrawlerMapOutput } from '@corvid/tool-contracts';
import { type BaseCheckpointSaver, END, START, StateGraph, interrupt } from '@langchain/langgraph';

import { type ApprovalDecision, type ApprovalRequest, ScanState } from './state.ts';

// The scan-lifecycle graph (ADR-27). It walks the `02` §5.1 states and pauses for human approval at
// a durable `interrupt()`. The reasoning nodes (perceive → hypothesize → plan) are real (Unit 3);
// `crawl` (Unit 2) and the tester operations (`test`, Units 4–5) are injected/stubbed so this graph
// is orchestration only — the node LOGIC lives in @corvid/agent-core and is tested there. The graph
// depends on injected operations so it is testable without the crawler process, a DB, or an LLM.

export interface ScanGraphDeps {
  /** Map the target's attack surface (Unit 2 `crawler.map`), bound to the scan's recorded target. */
  crawl(scanId: string): Promise<CrawlerMapOutput>;
  /** Generate + persist hypotheses (agent-core `hypothesize` bound to its context). */
  hypothesize(input: HypothesizeInput): Promise<HypothesizeOutcome>;
  /** Select tester + intended payload for each pending hypothesis (agent-core `plan`). */
  plan(scanId: string): Promise<PlanOutcome>;
}

export function buildScanGraph(checkpointer: BaseCheckpointSaver, deps: ScanGraphDeps) {
  return (
    new StateGraph(ScanState)
      .addNode('authorize', () => ({ status: 'crawling' as const }))
      .addNode('crawl', async (state) => {
        const crawlMap = await deps.crawl(state.scanId);
        return { crawlMap, status: 'hypothesizing' as const };
      })
      .addNode('perceive', (state) => {
        if (state.crawlMap === null) {
          throw new Error('perceive: no crawl map in state (crawl must run first)');
        }
        return { surface: perceive(state.crawlMap) };
      })
      .addNode('hypothesize', async (state) => {
        if (state.surface === null) {
          throw new Error('hypothesize: no surface in state (perceive must run first)');
        }
        const outcome = await deps.hypothesize({
          scanId: state.scanId,
          userId: state.userId,
          surface: state.surface,
        });
        return { hypothesizeStatus: outcome.kind };
      })
      .addNode('plan', async (state) => {
        await deps.plan(state.scanId);
        return { status: 'awaiting_approval' as const };
      })
      .addNode('awaitApproval', (state) => {
        // Durable pause. On resume the node re-runs from here and `interrupt` returns the decision;
        // there is no side effect before it, so a replay is safe (§3, ADR-27).
        const decision = interrupt<ApprovalRequest, ApprovalDecision>({
          kind: 'approval_request',
          scanId: state.scanId,
        });
        return { status: 'testing' as const, approvedHypotheses: [...decision.approvedHypotheses] };
      })
      // Terminal for the non-approval branch: record a real lifecycle state so a scan that ended via
      // a generation error or the spend stop reads `stopped` (not a stale `hypothesizing`). The
      // reason is already in `hypothesizeStatus`; the scan is re-runnable (hypothesize is replay-safe).
      .addNode('markStopped', () => ({ status: 'stopped' as const }))
      .addNode('test', () => ({ status: 'reporting' as const }))
      .addNode('report', () => ({ status: 'completed' as const }))
      .addEdge(START, 'authorize')
      .addEdge('authorize', 'crawl')
      .addEdge('crawl', 'perceive')
      .addEdge('perceive', 'hypothesize')
      // Only a successful generation proceeds to plan → approval. A generation error or a spend stop
      // ends the run without an approval gate (`01` §12); the scan is re-runnable and hypothesize is
      // replay-safe, so no partial/duplicate state results.
      .addConditionalEdges(
        'hypothesize',
        (state) => (state.hypothesizeStatus === 'generated' ? 'generated' : 'stop'),
        { generated: 'plan', stop: 'markStopped' },
      )
      .addEdge('markStopped', END)
      .addEdge('plan', 'awaitApproval')
      .addEdge('awaitApproval', 'test')
      .addEdge('test', 'report')
      .addEdge('report', END)
      .compile({ checkpointer })
  );
}
