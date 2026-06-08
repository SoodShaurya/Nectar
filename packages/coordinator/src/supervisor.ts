/**
 * Deterministic supervisor tick.
 *
 * The coordinator is primarily EVENT-DRIVEN: player chat, task complete/fail,
 * command-ack timeout, and BSM disconnect each push an `llm.invoke` immediately.
 * This tick is the cheap, non-LLM backstop that catches drift no event reports.
 * It only spends an LLM call when a deterministic condition actually fires, so an
 * idle-but-active swarm costs ~nothing instead of a reasoning call every tick.
 *
 * Two responsibilities:
 *  1. Stall watchdog — a 'busy' (acked) task that runs past `stallAfterMs` with no
 *     completion event is surfaced once for re-evaluation.
 *  2. Quiet backstop — if the event stream has been silent for `quietBackstopMs`
 *     despite open work (active goals or idle agents), do one sweep. During active
 *     event-driven operation this never fires because each invoke refreshes the
 *     activity clock.
 *
 * The logic is extracted here (rather than inline in index.ts) so it is unit
 * testable against real components.
 */

import { createLogger, metrics } from '@aetherius/shared-types';
import { AgentManager } from './agents';
import { GoalBoard } from './goal-board';
import { CoordinatorLLM } from './llm';

const logger = createLogger('coordinator:supervisor');

export interface SupervisorConfig {
  /** A busy task running longer than this with no completion event is a stall. */
  stallAfterMs: number;
  /** If no coordinator activity for this long despite open work, do one sweep. */
  quietBackstopMs: number;
}

/** Minimal surfaces the tick needs — keeps it cheap to stub in tests. */
export interface SupervisorDeps {
  agents: Pick<AgentManager, 'getStalledAgents' | 'markStallFlagged' | 'getAgentCount' | 'getIdleAgents'>;
  goalBoard: Pick<GoalBoard, 'getActiveGoals'>;
  llm: Pick<CoordinatorLLM, 'isBusy' | 'getLastInvokeTime' | 'invoke'>;
}

/** What a tick decided — returned for observability/testing. */
export type SupervisorAction =
  | { kind: 'busy' }
  | { kind: 'stall'; agentId: string }
  | { kind: 'quiet-sweep' }
  | { kind: 'idle' };

/**
 * Run one deterministic supervisor pass. Performs at most one `llm.invoke` and
 * returns what it decided. `now` is injected so callers/tests control time.
 */
export async function supervisorTick(
  deps: SupervisorDeps,
  cfg: SupervisorConfig,
  now: number,
): Promise<SupervisorAction> {
  const { agents, goalBoard, llm } = deps;

  // Don't pile work on an invocation already in flight (reasoning calls can take
  // tens of seconds); we'll re-check on the next tick.
  if (llm.isBusy()) return { kind: 'busy' };

  // 1. Stall watchdog (deterministic, no LLM cost). Surface one stall per tick.
  const stalled = agents.getStalledAgents(now, cfg.stallAfterMs);
  if (stalled.length > 0) {
    const s = stalled[0];
    agents.markStallFlagged(s.agentId);
    logger.warn('Stall detected — surfacing to coordinator', s);
    metrics.increment('supervisor_stall_detected');
    void llm.invoke({ type: 'stall', agentId: s.agentId, taskId: s.taskId, taskType: s.taskType, elapsedMs: s.elapsedMs });
    return { kind: 'stall', agentId: s.agentId };
  }

  // 2. Quiet backstop — only when the event stream has gone silent AND there is
  //    potential work. During active operation this is suppressed.
  if (now - llm.getLastInvokeTime() < cfg.quietBackstopMs) return { kind: 'idle' };
  if (agents.getAgentCount() === 0) return { kind: 'idle' };
  const activeGoals = await goalBoard.getActiveGoals();
  if (activeGoals.length > 0 || agents.getIdleAgents().length > 0) {
    logger.info('Quiet backstop sweep (event stream idle with open work)');
    metrics.increment('supervisor_quiet_sweep');
    void llm.invoke({ type: 'periodic', reason: 'quiet-backstop' });
    return { kind: 'quiet-sweep' };
  }
  return { kind: 'idle' };
}
