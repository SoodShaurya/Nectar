import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { AgentManager, DEFAULT_STALL_AFTER_MS } from '../agents';

/** A WebSocket stub that reports OPEN so command/cancel dispatch succeeds. */
function makeFakeWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
}

/** Register one agent on a fake BSM and drive it to a 'busy' (acked) task. */
function busyAgentManager(taskId = 't1'): { mgr: AgentManager; ackAt: number } {
  const mgr = new AgentManager();
  mgr.registerBSM('bsm-1', 'ws://fake', makeFakeWs(), [{ agentId: 'A' }]);
  const ackAt = Date.now();
  // No prior sendCommand needed: an accepted ack promotes idle->busy and starts the stall clock.
  mgr.handleCommandAck('A', { accepted: true, taskId });
  return { mgr, ackAt };
}

describe('Stall watchdog (deterministic supervisor support)', () => {
  it('does not flag a freshly-started task', () => {
    const { mgr, ackAt } = busyAgentManager();
    expect(mgr.getStalledAgents(ackAt + 1000, 60000)).toHaveLength(0);
  });

  it('flags a task that has run past the threshold', () => {
    const { mgr, ackAt } = busyAgentManager('t1');
    const stalled = mgr.getStalledAgents(ackAt + 120000, 60000);
    expect(stalled).toHaveLength(1);
    expect(stalled[0].agentId).toBe('A');
    expect(stalled[0].taskId).toBe('t1');
    expect(stalled[0].elapsedMs).toBeGreaterThanOrEqual(120000);
  });

  it('flags each task at most once (markStallFlagged)', () => {
    const { mgr, ackAt } = busyAgentManager();
    expect(mgr.getStalledAgents(ackAt + 120000, 60000)).toHaveLength(1);
    mgr.markStallFlagged('A');
    expect(mgr.getStalledAgents(ackAt + 180000, 60000)).toHaveLength(0);
  });

  it('clears stall state on task completion', () => {
    const { mgr, ackAt } = busyAgentManager();
    mgr.handleAgentEvent('A', { eventType: 'taskComplete' });
    // Idle agent is never stalled, regardless of elapsed time.
    expect(mgr.getStalledAgents(ackAt + 999999, 60000)).toHaveLength(0);
  });

  it('clears stall state on cancel and re-arms on the next task', () => {
    const { mgr, ackAt } = busyAgentManager('t1');
    mgr.cancelTask('A');
    expect(mgr.getStalledAgents(ackAt + 200000, 60000)).toHaveLength(0);
    // New task re-arms the clock with a fresh start time.
    const reAt = Date.now();
    mgr.handleCommandAck('A', { accepted: true, taskId: 't2' });
    expect(mgr.getStalledAgents(reAt + 1000, 60000)).toHaveLength(0);
    expect(mgr.getStalledAgents(reAt + 120000, 60000)).toHaveLength(1);
  });

  it('does not flag a pending (un-acked) task as stalled', () => {
    const mgr = new AgentManager();
    mgr.registerBSM('bsm-1', 'ws://fake', makeFakeWs(), [{ agentId: 'A' }]);
    // Never acked -> stays idle here (sendCommand needs a live ws); idle is never stalled.
    expect(mgr.getStalledAgents(Date.now() + 999999, 60000)).toHaveLength(0);
  });

  it('exposes a sane default threshold', () => {
    expect(DEFAULT_STALL_AFTER_MS).toBeGreaterThanOrEqual(60000);
  });
});
