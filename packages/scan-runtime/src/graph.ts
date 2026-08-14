import {
  perceive,
  type HypothesizeInput,
  type HypothesizeOutcome,
  type PlanOutcome,
} from '@corvid/agent-core';
import type { CrawlerMapOutput, VulnClass } from '@corvid/tool-contracts';
import {
  verifyInjection,
  verifyIdor,
  verifyJwt,
  verifySsrf,
  type VerificationProof,
  type VerifyResult,
} from '@corvid/verify';
import { type BaseCheckpointSaver, END, START, StateGraph, interrupt } from '@langchain/langgraph';

import { type ApprovalDecision, type ApprovalRequest, ScanState } from './state.ts';
import type { ObservedHypothesis, OobWaitRequest, OobWaitResume, PendingOob, VerifiedFinding } from './verify-phase.ts';

type VerifiedResult = Extract<VerifyResult, { readonly kind: 'verified' }>;

/** A safe, per-class technique descriptor for the finding's `payload` column (never a raw body). */
function payloadDescriptor(vulnClass: VulnClass, signals: VerificationProof['signals']): string {
  switch (vulnClass) {
    case 'jwt':
      return String(signals.mutation ?? 'forged-jwt');
    case 'injection':
      return String(signals.payloadFamily ?? signals.dialect ?? 'sqli');
    case 'idor':
      return 'cross-session-object-read';
    case 'ssrf':
      return 'oob-url-injection';
  }
}

function toFinding(hypothesisId: string, vulnClass: VulnClass, verdict: VerifiedResult): VerifiedFinding {
  return {
    hypothesisId,
    vulnClass,
    payload: payloadDescriptor(vulnClass, verdict.proof.signals),
    proof: verdict.proof.summary,
    severity: verdict.severity,
  };
}

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
  /**
   * Run the testers for the approved hypotheses and return their observations (the act + observe
   * step, Unit 4). Emits observations only — never a verdict (§8). The real impl wires the tester
   * tools + `http.send` + the OOB registrar; the graph stays testable with a fake.
   */
  observe(scanId: string, hypothesisIds: readonly string[]): Promise<readonly ObservedHypothesis[]>;
  /** Persist a VERIFIED finding (the deterministic gate already decided). Replay-safe (insertFinding). */
  persistFinding(finding: VerifiedFinding): Promise<void>;
  /** The OOB listener read used to confirm blind SSRF — a correlated callback, never a socket result. */
  readonly oob: { wasCalledBack(token: string): Promise<boolean> };
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
      // act + observe: run the approved hypotheses' testers; collect observations (no verdict, §8).
      .addNode('test', async (state) => {
        const observations = await deps.observe(state.scanId, state.approvedHypotheses);
        return { observations: [...observations] };
      })
      // verify (deterministic gate, in-process, no LLM — ADR-01): synchronous classes decide here;
      // blind SSRF is split out to await its out-of-band callback.
      .addNode('verify', async (state) => {
        const pendingOob: PendingOob[] = [];
        let verified = 0;
        for (const observed of state.observations) {
          const o = observed.observation;
          if (o === null) continue; // tester could not send → not_confirmed, nothing to persist
          if (o.vulnClass === 'ssrf') {
            pendingOob.push({ hypothesisId: observed.hypothesisId, observation: o });
            continue;
          }
          const verdict: VerifyResult =
            o.vulnClass === 'jwt' ? verifyJwt(o) : o.vulnClass === 'injection' ? verifyInjection(o) : verifyIdor(o);
          if (verdict.kind === 'verified') {
            await deps.persistFinding(toFinding(observed.hypothesisId, o.vulnClass, verdict));
            verified += 1;
          }
        }
        return { pendingOob, verifiedCount: verified };
      })
      // Durable OOB wait (D-4). Pauses for the correlated callback; the timeout sweep resumes it at
      // the 5-min bound (ADR-27). On resume the listener's ledger is read to decide each token.
      .addNode('awaitOob', async (state) => {
        // No side effect before the interrupt, so a replay is safe (§3). The resume value (timedOut)
        // is the sweep's signal; correlation is read from the ledger below regardless.
        interrupt<OobWaitRequest, OobWaitResume>({
          kind: 'oob_wait',
          scanId: state.scanId,
          tokens: state.pendingOob.map((p) => p.observation.oobToken),
        });
        let verified = state.verifiedCount;
        for (const pending of state.pendingOob) {
          const calledBack = await deps.oob.wasCalledBack(pending.observation.oobToken);
          const verdict = verifySsrf(pending.observation, calledBack);
          if (verdict.kind === 'verified') {
            await deps.persistFinding(toFinding(pending.hypothesisId, 'ssrf', verdict));
            verified += 1;
          }
        }
        return { verifiedCount: verified, pendingOob: [] as PendingOob[] };
      })
      .addNode('complete', () => ({ status: 'completed' as const }))
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
      .addEdge('test', 'verify')
      // Blind SSRF present → wait out of band; otherwise the synchronous verdicts are final.
      .addConditionalEdges('verify', (state) => (state.pendingOob.length > 0 ? 'await' : 'done'), {
        await: 'awaitOob',
        done: 'complete',
      })
      .addEdge('awaitOob', 'complete')
      .addEdge('complete', END)
      .compile({ checkpointer })
  );
}
