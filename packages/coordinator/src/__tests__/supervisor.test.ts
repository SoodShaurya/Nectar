import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { AgentManager } from '../agents';
import { supervisorTick, SupervisorConfig, SupervisorDeps } from '../supervisor';

const CFG: SupervisorConfig = { stallAfterMs: 60000, quietBackstopMs: 120000 };

function makeFakeWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
}

/** A stub LLM recording invocations, with controllable busy/last-activity state. */
function stubLlm(opts: { busy?: boolean; lastInvokeAt?: number } = {}) {
  const calls: any[] = [];
  return {
    calls,
    isBusy: () => opts.busy ?? false,
    getLastInvokeTime: () => opts.lastInvokeAt ?? 0,
    invoke: async (e: any) => { calls.push(e); },
  };
}

function deps(agents: AgentManager, llm: any, activeGoals: any[] = []): SupervisorDeps {
  return { agents, llm, goalBoard: { getActiveGoals: async () => activeGoals } as any };
}

describe('supervisorTick (deterministic backstop)', () => {
  it('does nothing while an invocation is in flight', async () => {
    const agents = new AgentManager();
    const llm = stubLlm({ busy: true });
    const action = await supervisorTick(deps(agents, llm), CFG, Date.now());
    expect(action).toEqual({ kind: 'busy' });
    expect(llm.calls).toHaveLength(0);
  });

  it('surfaces a stall (one invoke, type=stall) and flags it once', async () => {
    const agents = new AgentManager();
    agents.registerBSM('bsm', 'ws://x', makeFakeWs(), [{ agentId: 'A' }]);
    const ackAt = Date.now();
    agents.handleCommandAck('A', { accepted: true, taskId: 't1' });
    const llm = stubLlm({ lastInvokeAt: ackAt });

    const first = await supervisorTick(deps(agents, llm), CFG, ackAt + 120000);
    expect(first).toEqual({ kind: 'stall', agentId: 'A' });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ type: 'stall', agentId: 'A', taskId: 't1' });

    // Next tick must NOT re-surface the same stall.
    const second = await supervisorTick(deps(agents, llm), CFG, ackAt + 180000);
    expect(second.kind).not.toBe('stall');
    expect(llm.calls).toHaveLength(1);
  });

  it('does a quiet-backstop sweep when idle-with-work and the stream is silent', async () => {
    const agents = new AgentManager();
    agents.registerBSM('bsm', 'ws://x', makeFakeWs(), [{ agentId: 'A' }]); // A is idle
    const llm = stubLlm({ lastInvokeAt: 0 });
    const now = 10_000_000;
    const action = await supervisorTick(deps(agents, llm, [{ goalId: 'g1' }]), CFG, now);
    expect(action).toEqual({ kind: 'quiet-sweep' });
    expect(llm.calls[0]).toMatchObject({ type: 'periodic', reason: 'quiet-backstop' });
  });

  it('suppresses the quiet sweep while the event stream is active', async () => {
    const agents = new AgentManager();
    agents.registerBSM('bsm', 'ws://x', makeFakeWs(), [{ agentId: 'A' }]);
    const now = 10_000_000;
    // Last activity was 30s ago — well under the 120s quiet threshold.
    const llm = stubLlm({ lastInvokeAt: now - 30_000 });
    const action = await supervisorTick(deps(agents, llm, [{ goalId: 'g1' }]), CFG, now);
    expect(action).toEqual({ kind: 'idle' });
    expect(llm.calls).toHaveLength(0);
  });

  it('does nothing when there are no agents', async () => {
    const agents = new AgentManager();
    const llm = stubLlm({ lastInvokeAt: 0 });
    const action = await supervisorTick(deps(agents, llm, [{ goalId: 'g1' }]), CFG, 10_000_000);
    expect(action).toEqual({ kind: 'idle' });
    expect(llm.calls).toHaveLength(0);
  });

  it('prioritises a stall over the quiet sweep', async () => {
    const agents = new AgentManager();
    agents.registerBSM('bsm', 'ws://x', makeFakeWs(), [{ agentId: 'A' }, { agentId: 'B' }]);
    const ackAt = Date.now();
    agents.handleCommandAck('A', { accepted: true, taskId: 't1' }); // A busy -> will stall
    // B stays idle (open work), stream silent -> would also qualify for a sweep.
    const llm = stubLlm({ lastInvokeAt: 0 });
    const action = await supervisorTick(deps(agents, llm, [{ goalId: 'g1' }]), CFG, ackAt + 120000);
    expect(action.kind).toBe('stall');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].type).toBe('stall');
  });
});
