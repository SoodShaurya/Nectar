/**
 * Agent state tracking and command dispatch.
 * Maintains knowledge of all registered agents across all BSMs.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { AgentInfo, WebSocketMessage, CompletionCondition, Coordinates, createLogger, metrics, MsgType } from '@aetherius/shared-types';

const logger = createLogger('coordinator:agents');

/** How long to wait for an agent to ack a dispatched command before giving up. */
const COMMAND_ACK_TIMEOUT_MS = 10000;

/**
 * Coordinator-internal agent status. Extends the frozen shared-types union
 * (`idle | busy | unknown`) with a transient `pending` state used while a
 * dispatched command is awaiting acknowledgment (design [A]).
 */
export type CoordinatorAgentStatus = AgentInfo['status'] | 'pending';

export interface ExtendedAgentInfo extends Omit<AgentInfo, 'status'> {
  status: CoordinatorAgentStatus;
  inventoryMap: Record<string, number>;
  currentTaskId?: string;
  lastStatusUpdate?: number;
}

/**
 * Manages agent state and command dispatch. Extends EventEmitter so index.ts
 * (which owns the LLM) can react to lifecycle changes that require a replan:
 *   - 'replan' { reason, agentId? } — emitted on ack timeout or BSM disconnect
 *     where an agent had an active task and the LLM should re-evaluate.
 */
export class AgentManager extends EventEmitter {
  private knownBSMs: Map<string, { address: string; ws: WebSocket }> = new Map();
  private knownAgents: Map<string, ExtendedAgentInfo> = new Map();
  /** Pending command-ack timers, keyed by agentId. */
  private ackTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
  }

  // --- BSM Registration ---
  registerBSM(
    bsmId: string,
    address: string,
    ws: WebSocket,
    agents: Array<{ agentId: string; status?: string }>
  ): void {
    logger.info(`BSM registered: ${bsmId} at ${address} with ${agents.length} agents`);
    this.knownBSMs.set(bsmId, { address, ws });

    for (const agentData of agents) {
      if (!this.knownAgents.has(agentData.agentId)) {
        logger.info(`Registering new agent: ${agentData.agentId} from BSM ${bsmId}`);
        this.knownAgents.set(agentData.agentId, {
          agentId: agentData.agentId,
          bsmAddress: address,
          status: 'idle',
          inventoryMap: {},
        });
      } else {
        const agent = this.knownAgents.get(agentData.agentId)!;
        agent.bsmAddress = address;
      }
    }
    metrics.increment('bsm_registrations');
  }

  handleBSMDisconnect(ws: WebSocket): string | null {
    let disconnectedBsmId: string | null = null;
    let hadActiveTask = false;
    for (const [id, bsm] of this.knownBSMs) {
      if (bsm.ws === ws) {
        disconnectedBsmId = id;
        const bsmAddress = bsm.address;
        this.knownBSMs.delete(id);
        // Mark agents from this BSM as unknown and clear any active task so they
        // are not stuck 'busy'/'pending' (design [B]).
        for (const agent of this.knownAgents.values()) {
          if (agent.bsmAddress === bsmAddress) {
            if (agent.currentTaskId) {
              hadActiveTask = true;
            }
            this.clearAckTimeout(agent.agentId);
            agent.status = 'unknown';
            agent.currentTaskId = undefined;
            agent.currentTaskType = undefined;
            logger.warn(`Agent ${agent.agentId} marked unknown (BSM ${id} disconnected)`);
          }
        }
        break;
      }
    }

    // If any disconnected agent had an active task, surface a replan trigger.
    if (hadActiveTask) {
      this.emit('replan', { reason: 'bsmDisconnect', bsmId: disconnectedBsmId });
    }

    return disconnectedBsmId;
  }

  // --- Agent Status Updates ---
  updateAgentStatus(agentId: string, snapshot: any): void {
    const agent = this.knownAgents.get(agentId);
    if (!agent) {
      logger.warn(`Status update for unknown agent: ${agentId}`);
      return;
    }

    if (snapshot.status) {
      agent.lastKnownLocation = snapshot.status.position;

      // Parse key inventory into map
      if (snapshot.status.keyInventory && Array.isArray(snapshot.status.keyInventory)) {
        agent.inventoryMap = {};
        for (const item of snapshot.status.keyInventory) {
          agent.inventoryMap[item.name] = item.count;
        }
      }

      agent.lastStatusUpdate = Date.now();
    }
  }

  // --- Agent Event Handling ---
  handleAgentEvent(agentId: string, event: any): { shouldReplan: boolean; eventType: string } {
    const agent = this.knownAgents.get(agentId);
    const eventType = event.eventType ?? event.type ?? 'unknown';

    if (agent) {
      if (eventType === 'taskComplete' || eventType === 'taskFailed' || eventType === 'taskRejected') {
        agent.status = 'idle';
        agent.currentTaskId = undefined;
        agent.currentTaskType = undefined;
        metrics.increment(`agent_${eventType}`);
      }
    }

    // Determine if this event should trigger replanning
    const replanEvents = ['taskComplete', 'taskFailed', 'taskRejected', 'behaviorAlert', 'playerChat'];
    return {
      shouldReplan: replanEvents.includes(eventType),
      eventType,
    };
  }

  // --- Command Dispatch ---
  sendCommand(agentId: string, taskId: string, task: { type: string; details: any }, completionCondition?: CompletionCondition): boolean {
    const agent = this.knownAgents.get(agentId);
    if (!agent) {
      logger.error(`Cannot send command: agent ${agentId} not found`);
      return false;
    }

    const bsmWs = this.findBSMForAgent(agent);
    if (!bsmWs || bsmWs.readyState !== WebSocket.OPEN) {
      logger.error(`Cannot send command: BSM not connected for agent ${agentId}`);
      return false;
    }

    const message: WebSocketMessage = {
      type: MsgType.AgentCommand,
      senderId: 'coordinator',
      payload: { agentId, taskId, task, completionCondition },
    };

    bsmWs.send(JSON.stringify(message));

    // Do NOT optimistically mark 'busy'. The agent must ack the command first
    // (design [A]). Mark 'pending', remember the taskId/type, and start an ack
    // timeout. The status is promoted to 'busy' in handleCommandAck().
    agent.status = 'pending';
    agent.currentTaskId = taskId;
    agent.currentTaskType = task.type as any;
    agent.lastStatusUpdate = Date.now();
    this.startAckTimeout(agentId, taskId);

    logger.info(`Command sent to ${agentId}: ${task.type} (${taskId}) — awaiting ack`);
    metrics.increment('commands_sent');
    return true;
  }

  /**
   * Handle a command acknowledgment relayed from the BSM (design [A] step 5).
   * Returns whether index.ts should trigger a replan (true on rejection).
   */
  handleCommandAck(
    agentId: string,
    payload: { agentId?: string; taskId?: string; accepted?: boolean; reason?: string },
  ): { shouldReplan: boolean } {
    const agent = this.knownAgents.get(agentId);
    this.clearAckTimeout(agentId);

    if (!agent) {
      logger.warn(`Command ack for unknown agent: ${agentId}`);
      return { shouldReplan: false };
    }

    // Ignore stale acks for a task the agent is no longer running.
    if (payload.taskId && agent.currentTaskId && payload.taskId !== agent.currentTaskId) {
      logger.warn(`Stale command ack for ${agentId}`, {
        ackTaskId: payload.taskId,
        currentTaskId: agent.currentTaskId,
      });
      return { shouldReplan: false };
    }

    if (payload.accepted) {
      agent.status = 'busy';
      agent.currentTaskId = payload.taskId ?? agent.currentTaskId;
      logger.info(`Command accepted by ${agentId} (${agent.currentTaskId})`);
      metrics.increment('commands_accepted');
      return { shouldReplan: false };
    }

    // Rejected — free the agent and let the coordinator replan.
    agent.status = 'idle';
    agent.currentTaskId = undefined;
    agent.currentTaskType = undefined;
    logger.warn(`Command rejected by ${agentId}`, { reason: payload.reason });
    metrics.increment('commands_rejected');
    return { shouldReplan: true };
  }

  cancelTask(agentId: string, taskId?: string): boolean {
    const agent = this.knownAgents.get(agentId);
    if (!agent) {
      logger.error(`Cannot cancel task: agent ${agentId} not found`);
      return false;
    }

    const bsmWs = this.findBSMForAgent(agent);
    if (!bsmWs || bsmWs.readyState !== WebSocket.OPEN) {
      logger.error(`Cannot cancel task: BSM not connected for agent ${agentId}`);
      return false;
    }

    const message: WebSocketMessage = {
      type: MsgType.CancelTask,
      senderId: 'coordinator',
      payload: { agentId, taskId: taskId ?? agent.currentTaskId },
    };
    bsmWs.send(JSON.stringify(message));

    this.clearAckTimeout(agentId);
    agent.status = 'idle';
    agent.currentTaskId = undefined;
    agent.currentTaskType = undefined;

    logger.info(`Task cancelled for ${agentId}`);
    metrics.increment('tasks_cancelled');
    return true;
  }

  sendChatMessage(agentId: string, chatMessage: string): boolean {
    const agent = this.knownAgents.get(agentId);
    if (!agent) {
      // If no specific agent, try sending via any connected agent
      const anyAgent = this.getAllAgents().find(a => a.status !== 'unknown');
      if (!anyAgent) {
        logger.error('Cannot send chat: no agents available');
        return false;
      }
      return this.sendChatMessage(anyAgent.agentId, chatMessage);
    }

    const bsmWs = this.findBSMForAgent(agent);
    if (!bsmWs || bsmWs.readyState !== WebSocket.OPEN) {
      logger.error(`Cannot send chat: BSM not connected for agent ${agentId}`);
      return false;
    }

    const message: WebSocketMessage = {
      type: MsgType.ChatMessage,
      senderId: 'coordinator',
      payload: { agentId, message: chatMessage },
    };
    bsmWs.send(JSON.stringify(message));

    logger.info(`Chat sent via ${agentId}: "${chatMessage}"`);
    return true;
  }

  sendProfile(agentId: string, profile: any): boolean {
    const agent = this.knownAgents.get(agentId);
    if (!agent) {
      logger.error(`Cannot send profile: agent ${agentId} not found`);
      return false;
    }

    const bsmWs = this.findBSMForAgent(agent);
    if (!bsmWs || bsmWs.readyState !== WebSocket.OPEN) {
      logger.error(`Cannot send profile: BSM not connected for agent ${agentId}`);
      return false;
    }

    const message: WebSocketMessage = {
      type: MsgType.UpdateProfile,
      senderId: 'coordinator',
      payload: { agentId, profile },
    };

    bsmWs.send(JSON.stringify(message));
    logger.info(`Profile update sent to ${agentId}`);
    return true;
  }

  // --- Queries ---
  getInventories(): Record<string, Record<string, number>> {
    const inventories: Record<string, Record<string, number>> = {};
    for (const [id, agent] of this.knownAgents) {
      inventories[id] = { ...agent.inventoryMap };
    }
    return inventories;
  }

  getIdleAgents(): ExtendedAgentInfo[] {
    return Array.from(this.knownAgents.values()).filter(a => a.status === 'idle');
  }

  getBusyAgents(): ExtendedAgentInfo[] {
    return Array.from(this.knownAgents.values()).filter(a => a.status === 'busy');
  }

  getAllAgents(): ExtendedAgentInfo[] {
    return Array.from(this.knownAgents.values());
  }

  getAgentById(id: string): ExtendedAgentInfo | null {
    return this.knownAgents.get(id) ?? null;
  }

  getAgentCount(): number {
    return this.knownAgents.size;
  }

  getBSMCount(): number {
    return this.knownBSMs.size;
  }

  // --- Internal ---
  private findBSMForAgent(agent: ExtendedAgentInfo): WebSocket | null {
    for (const bsm of this.knownBSMs.values()) {
      if (bsm.address === agent.bsmAddress) {
        return bsm.ws;
      }
    }
    return null;
  }

  /** Start (replacing any existing) command-ack timeout for an agent (design [A] step 6). */
  private startAckTimeout(agentId: string, taskId: string): void {
    this.clearAckTimeout(agentId);
    const timer = setTimeout(() => {
      this.ackTimeouts.delete(agentId);
      const agent = this.knownAgents.get(agentId);
      // Only act if the agent is still awaiting ack for this exact task.
      if (!agent || agent.currentTaskId !== taskId || agent.status !== 'pending') {
        return;
      }
      // No ack arrived: free the agent and trigger a replan.
      agent.status = 'unknown';
      agent.currentTaskId = undefined;
      agent.currentTaskType = undefined;
      logger.warn(`Command ack timeout for ${agentId} (${taskId}) — no ack received`);
      metrics.increment('command_ack_timeouts');
      this.emit('replan', { reason: 'ackTimeout', agentId });
    }, COMMAND_ACK_TIMEOUT_MS);
    this.ackTimeouts.set(agentId, timer);
  }

  /** Clear a pending command-ack timeout for an agent, if any. */
  private clearAckTimeout(agentId: string): void {
    const timer = this.ackTimeouts.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.ackTimeouts.delete(agentId);
    }
  }
}
