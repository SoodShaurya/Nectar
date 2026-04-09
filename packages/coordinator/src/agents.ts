/**
 * Agent state tracking and command dispatch.
 * Maintains knowledge of all registered agents across all BSMs.
 */

import WebSocket from 'ws';
import { AgentInfo, WebSocketMessage, CompletionCondition, Coordinates, createLogger, metrics } from '@aetherius/shared-types';

const logger = createLogger('coordinator:agents');

export interface ExtendedAgentInfo extends AgentInfo {
  inventoryMap: Record<string, number>;
  currentTaskId?: string;
  lastStatusUpdate?: number;
}

export class AgentManager {
  private knownBSMs: Map<string, { address: string; ws: WebSocket }> = new Map();
  private knownAgents: Map<string, ExtendedAgentInfo> = new Map();

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
    for (const [id, bsm] of this.knownBSMs) {
      if (bsm.ws === ws) {
        disconnectedBsmId = id;
        const bsmAddress = bsm.address;
        this.knownBSMs.delete(id);
        // Mark agents from this BSM as unknown
        for (const agent of this.knownAgents.values()) {
          if (agent.bsmAddress === bsmAddress) {
            agent.status = 'unknown';
            logger.warn(`Agent ${agent.agentId} marked unknown (BSM ${id} disconnected)`);
          }
        }
        break;
      }
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
      type: 'orchestrator::agentCommand',
      senderId: 'coordinator',
      payload: { agentId, taskId, task, completionCondition },
    };

    bsmWs.send(JSON.stringify(message));

    agent.status = 'busy';
    agent.currentTaskId = taskId;
    agent.currentTaskType = task.type as any;

    logger.info(`Command sent to ${agentId}: ${task.type} (${taskId})`);
    metrics.increment('commands_sent');
    return true;
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
      type: 'orchestrator::cancelTask',
      senderId: 'coordinator',
      payload: { agentId, taskId: taskId ?? agent.currentTaskId },
    };
    bsmWs.send(JSON.stringify(message));

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
      type: 'orchestrator::chatMessage',
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
      type: 'orchestrator::updateProfile',
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
}
