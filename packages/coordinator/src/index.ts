/**
 * Aetherius Coordinator — Entry Point
 *
 * Conversational LLM agent that manages a goal board, assigns tasks directly
 * to agents via BSM, and converses with players through Minecraft chat.
 */

import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import {
  WebSocketMessage,
  createLogger,
  validateConfig,
  coordinatorConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  metrics,
} from '@aetherius/shared-types';
import { AgentManager } from './agents';
import { WorldStateClient } from './world-state';
import { GoalBoard } from './goal-board';
import { CoordinatorLLM } from './llm';

const logger = createLogger('coordinator');
const config = validateConfig(coordinatorConfigSchema, 'Coordinator');

logger.info('Starting Coordinator', {
  httpPort: config.COORDINATOR_PORT,
  wsPort: config.COORDINATOR_WS_PORT,
  worldStateApi: config.WORLD_STATE_API_ADDRESS,
});

// --- Core Components ---
const agents = new AgentManager();
const worldState = new WorldStateClient(config.WORLD_STATE_API_ADDRESS);
const goalBoard = new GoalBoard(config.WORLD_STATE_API_ADDRESS);
const llm = new CoordinatorLLM(
  config.GEMINI_API_KEY,
  agents,
  worldState,
  goalBoard,
  config.MC_VERSION,
);

// --- Frontend Clients ---
const connectedFrontendClients: Set<WebSocket> = new Set();

// --- WebSocket Server ---
const wss = new WebSocketServer({ port: config.COORDINATOR_WS_PORT });
logger.info('Coordinator WebSocket server started', { port: config.COORDINATOR_WS_PORT });

wss.on('connection', (ws: WebSocket) => {
  logger.debug('WS client connected');
  metrics.increment('ws_connections');

  ws.on('message', (message: Buffer) => {
    try {
      const parsed: WebSocketMessage = JSON.parse(message.toString());
      metrics.increment('ws_messages_received');

      // --- BSM Registration ---
      if (parsed.type === 'bsm::register') {
        const { bsmId, address, capacity, agents: agentList } = parsed.payload;
        if (bsmId && address && agentList && Array.isArray(agentList)) {
          agents.registerBSM(bsmId, address, ws, agentList);
        } else {
          logger.error('Invalid bsm::register payload', { payload: parsed.payload });
        }
      }

      // --- Agent Events (routed via BSM) ---
      else if (parsed.type.startsWith('agent::event::')) {
        const event = parsed.payload;
        const agentId = event?.agentId ?? parsed.senderId;
        if (!agentId) return;

        const { shouldReplan, eventType } = agents.handleAgentEvent(agentId, event);
        logger.info(`Agent event: ${eventType} from ${agentId}`, { shouldReplan });

        if (eventType === 'playerChat') {
          // Always invoke coordinator for player chat
          llm.invoke({
            type: 'playerChat',
            agentId,
            playerName: event.details?.playerName ?? 'unknown',
            message: event.details?.message ?? '',
          });
        } else if (shouldReplan) {
          llm.invoke({ type: eventType, agentId, event });
        }
      }

      // --- Agent Status Updates ---
      else if (parsed.type === 'agent::statusUpdate') {
        const snapshot = parsed.payload;
        const agentId = snapshot?.agentId ?? parsed.senderId;
        if (agentId) {
          agents.updateAgentStatus(agentId, snapshot);
          // Status updates do NOT trigger the coordinator (too frequent)
        }
      }

      // --- Frontend ---
      else if (parsed.type === 'frontend::register') {
        logger.info('Frontend client registered');
        connectedFrontendClients.add(ws);
      }
      else if (parsed.type === 'frontend::startGoal') {
        const { goal, count } = parsed.payload;
        logger.info(`Goal from frontend: ${count ?? 1}x ${goal}`);
        llm.invoke({ type: 'startGoal', goal, count: count ?? 1 });
      }

    } catch (error) {
      logger.error('Failed to handle WS message', { error });
    }
  });

  ws.on('close', () => {
    connectedFrontendClients.delete(ws);
    const disconnectedBsm = agents.handleBSMDisconnect(ws);
    if (disconnectedBsm) {
      logger.info(`BSM ${disconnectedBsm} disconnected`);
    }
  });

  ws.on('error', (error: Error) => {
    logger.error('WebSocket error', { error });
    connectedFrontendClients.delete(ws);
    agents.handleBSMDisconnect(ws);
  });
});

// --- Periodic Timer (60s) ---
const PERIODIC_INTERVAL_MS = 60000;
const periodicTimer = setInterval(async () => {
  // Only invoke if we have agents and active goals
  if (agents.getAgentCount() > 0) {
    const activeGoals = await goalBoard.getActiveGoals();
    if (activeGoals.length > 0 || agents.getIdleAgents().length > 0) {
      llm.invoke({ type: 'periodic' });
    }
  }
}, PERIODIC_INTERVAL_MS);

// --- Health Checks ---
const healthCheck = new HealthCheck('coordinator', '0.1.0');

healthCheck.registerDependency('world-state-service', async () => {
  return await worldState.healthCheck();
});

healthCheck.registerDependency('gemini-api', async () => {
  const state = llm.getCircuitBreakerState();
  if (state === 'open') {
    return { status: 'degraded' as const, error: 'Circuit breaker open' };
  }
  return { status: 'connected' as const };
});

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    try {
      const health = await healthCheck.check();
      const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'coordinator', status: 'unhealthy', error: String(error) }));
    }
    return;
  }

  if (url.pathname === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics.getAllMetrics()));
    return;
  }

  // Default status
  let activeGoals: any[] = [];
  try { activeGoals = await goalBoard.getActiveGoals(); } catch {}

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'Coordinator Running',
    activeGoals: activeGoals.map(g => ({ id: g.goalId, description: g.description, priority: g.priority })),
    knownBSMs: agents.getBSMCount(),
    knownAgents: agents.getAgentCount(),
    idleAgents: agents.getIdleAgents().length,
    busyAgents: agents.getBusyAgents().length,
  }));
});

server.listen(config.COORDINATOR_PORT, () => {
  logger.info('Coordinator HTTP server listening', {
    port: config.COORDINATOR_PORT,
    endpoints: ['/health', '/metrics', '/'],
  });
});

// --- Startup ---
logger.info('Coordinator started. Waiting for connections...');

// --- Graceful Shutdown ---
const shutdown = createGracefulShutdown(logger);

shutdown.register(async () => {
  clearInterval(periodicTimer);
});

shutdown.register(async () => {
  logger.info('Closing WebSocket server...');
  wss.close();
});

shutdown.register(async () => {
  logger.info('Closing HTTP server...');
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});
