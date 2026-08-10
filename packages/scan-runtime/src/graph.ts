import { type BaseCheckpointSaver, END, START, StateGraph, interrupt } from '@langchain/langgraph';

import { type ApprovalDecision, type ApprovalRequest, ScanState } from './state.ts';

// Skeleton scan-lifecycle graph (Unit 1, ADR-27): it walks the `02` §5.1 states and pauses for
// human approval at a durable `interrupt()`. No real crawling/testing yet — the point of this unit
// is that the durable spine exists and survives a restart mid-pause. Each node returns the status
// of the state it transitions INTO, so every lifecycle state is a committed checkpoint value.

export function buildScanGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ScanState)
    .addNode('authorize', () => ({ status: 'crawling' as const }))
    .addNode('crawl', () => ({ status: 'hypothesizing' as const }))
    .addNode('hypothesize', () => ({ status: 'awaiting_approval' as const }))
    .addNode('awaitApproval', (state) => {
      // Durable pause. On resume the node re-runs from here and `interrupt` returns the decision;
      // there is no side effect before it, so a replay is safe (§3, ADR-27).
      const decision = interrupt<ApprovalRequest, ApprovalDecision>({
        kind: 'approval_request',
        scanId: state.scanId,
      });
      return { status: 'testing' as const, approvedHypotheses: [...decision.approvedHypotheses] };
    })
    .addNode('test', () => ({ status: 'reporting' as const }))
    .addNode('report', () => ({ status: 'completed' as const }))
    .addEdge(START, 'authorize')
    .addEdge('authorize', 'crawl')
    .addEdge('crawl', 'hypothesize')
    .addEdge('hypothesize', 'awaitApproval')
    .addEdge('awaitApproval', 'test')
    .addEdge('test', 'report')
    .addEdge('report', END)
    .compile({ checkpointer });
}
