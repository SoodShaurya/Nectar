import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import net from 'net';
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import {
  AgentStatusSnapshot,
  AgentEvent,
  WorldStateReportPayload,
  createLogger,
  validateConfig,
  bsmConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  HealthChecks,
  metrics,
  MsgType,
  TcpMsgType,
  agentEventType,
  parseWsMessage,
  parseTcpMessage,
  makeWsMessage,
  validatePayload,
  checkAuthToken,
  agentCommandPayloadSchema,
  cancelTaskPayloadSchema,
  chatMessagePayloadSchema,
  updateProfilePayloadSchema,
  agentRegisterPayloadSchema
} from '@aetherius/shared-types';

// --- Initialize Logger ---
const logger = createLogger('bot-server-manager');

// --- Validate Configuration ---
const config = validateConfig(bsmConfigSchema, 'Bot Server Manager');

const WS_PORT = config.BSM_WS_PORT;
const LOCAL_AGENT_PORT = config.BSM_AGENT_PORT;
// Upstream coordinator address: COORDINATOR_ADDRESS is preferred; ORCHESTRATOR_ADDRESS
// remains a deprecated fallback for older deployments.
const COORDINATOR_ADDRESS =
  config.COORDINATOR_ADDRESS ?? config.ORCHESTRATOR_ADDRESS ?? 'ws://localhost:5001';
if (!config.COORDINATOR_ADDRESS && config.ORCHESTRATOR_ADDRESS) {
  logger.warn(
    'ORCHESTRATOR_ADDRESS is deprecated; please set COORDINATOR_ADDRESS instead.'
  );
}
const WORLD_STATE_API_ADDRESS = config.WORLD_STATE_API_ADDRESS;
const BSM_ID = config.BSM_ID || `bsm-${Math.random().toString(36).substring(2, 8)}`;
const AGENT_SCRIPT_PATH = config.AGENT_SCRIPT_PATH || '../bot-agent/dist/index.js';

// --- Auth (optional cluster shared secret) ---
// If CLUSTER_AUTH_TOKEN is unset, auth is disabled (local-dev default). Log it once.
if (!config.CLUSTER_AUTH_TOKEN) {
  logger.warn('CLUSTER_AUTH_TOKEN is not set — agent/coordinator auth is DISABLED.');
}

// --- Outbound queue tuning ---
const AGENT_OUTBOUND_QUEUE_CAP = 50; // per-agent FIFO cap (BSM -> agent)
const UPSTREAM_QUEUE_CAP = 50; // buffered frames for coordinator (BSM -> coordinator)

logger.info('Starting Bot Server Manager', {
  bsmId: BSM_ID,
  wsPort: WS_PORT,
  agentPort: LOCAL_AGENT_PORT,
  coordinatorAddress: COORDINATOR_ADDRESS,
  worldStateApi: WORLD_STATE_API_ADDRESS,
  agentScriptPath: AGENT_SCRIPT_PATH
});

// --- State ---
interface ManagedAgent {
    process: ChildProcess;
    localSocket: net.Socket | null;
    status: 'starting' | 'running' | 'stopped' | 'errored';
    commanderId: string | null; // Commander ID (always 'coordinator' now)
    globalAgentId: string; // The ID known by the coordinator
    // Bounded FIFO of newline-terminated frames waiting for the agent's TCP socket
    // to become writable. Flushed in order on (re)connect/registration.
    outboundQueue: string[];
}
const managedAgents: Map<string, ManagedAgent> = new Map(); // Key: globalAgentId

interface ConnectedClient {
    ws: WebSocket;
    type: 'coordinator';
    id: string; // Coordinator ID
}
const connectedWSClients: Map<WebSocket, ConnectedClient> = new Map(); // Key: WebSocket instance

// --- Per-agent outbound queue helpers (design [C]) ---

/**
 * Send a newline-terminated TCP frame to a managed agent. If the agent's socket
 * is not currently writable, enqueue it (bounded FIFO) and flush in order once
 * the agent (re)connects. Never silently drops: on cap overflow the OLDEST frame
 * is dropped with a warning.
 */
function sendToAgent(agent: ManagedAgent, frame: object): void {
    const line = JSON.stringify(frame) + '\n';
    const socket = agent.localSocket;
    if (socket && !socket.destroyed && socket.writable && agent.status === 'running') {
        socket.write(line);
        return;
    }
    // Not writable — enqueue for later delivery.
    if (agent.outboundQueue.length >= AGENT_OUTBOUND_QUEUE_CAP) {
        agent.outboundQueue.shift(); // drop oldest
        logger.warn('Agent outbound queue full — dropping oldest frame', {
            agentId: agent.globalAgentId,
            cap: AGENT_OUTBOUND_QUEUE_CAP
        });
        metrics.increment('agent_outbound_dropped');
    }
    agent.outboundQueue.push(line);
    logger.debug('Enqueued frame for agent (socket not writable)', {
        agentId: agent.globalAgentId,
        queued: agent.outboundQueue.length
    });
    metrics.increment('agent_outbound_queued');
}

/** Flush any queued frames to an agent once its socket is writable. */
function flushAgentQueue(agent: ManagedAgent): void {
    const socket = agent.localSocket;
    if (!socket || socket.destroyed || !socket.writable) return;
    if (agent.outboundQueue.length === 0) return;
    logger.info('Flushing queued frames to agent', {
        agentId: agent.globalAgentId,
        count: agent.outboundQueue.length
    });
    while (agent.outboundQueue.length > 0) {
        const line = agent.outboundQueue.shift()!;
        socket.write(line);
        metrics.increment('agent_outbound_flushed');
    }
}

// --- Agent Lifecycle Management ---

function spawnAgent(globalAgentId: string): void {
    logger.info('Spawning agent process', { agentId: globalAgentId });
    const startTime = Date.now();
    const agentPath = path.resolve(__dirname, AGENT_SCRIPT_PATH);
    const agentProcess = fork(agentPath, [globalAgentId], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], // Inherit stdin, pipe stdout/stderr, enable IPC
        env: {
            ...process.env,
            AGENT_ID: globalAgentId,
            BSM_TCP_PORT: LOCAL_AGENT_PORT.toString(),
            // Add any other necessary env vars for the agent
        }
    });

    const agent: ManagedAgent = {
        process: agentProcess,
        localSocket: null,
        status: 'starting',
        commanderId: null, // Initially unassigned
        globalAgentId: globalAgentId,
        outboundQueue: [],
    };
    managedAgents.set(globalAgentId, agent);
    metrics.increment('agents_spawned');
    metrics.record('agent_spawn_time', Date.now() - startTime);

    agentProcess.stdout?.on('data', (data) => {
        logger.info(`[Agent ${globalAgentId} STDOUT]: ${data.toString().trim()}`);
    });

    agentProcess.stderr?.on('data', (data) => {
        logger.error(`[Agent ${globalAgentId} STDERR]: ${data.toString().trim()}`);
    });

    agentProcess.on('error', (err) => {
        logger.error('Agent process error', { agentId: globalAgentId, error: err });
        agent.status = 'errored';
        metrics.increment('agent_process_errors');
        // TODO: Implement restart logic? Notify Orchestrator?
    });

    agentProcess.on('exit', (code, signal) => {
        logger.info('Agent process exited', { agentId: globalAgentId, code, signal });
        agent.status = 'stopped';
        if (agent.localSocket && !agent.localSocket.destroyed) {
            agent.localSocket.destroy();
        }
        managedAgents.delete(globalAgentId);
        metrics.increment('agents_exited');
        if (code !== 0) {
            metrics.increment('agent_abnormal_exits');
        }
        // TODO: Notify Orchestrator/Commander?
    });

     agentProcess.on('message', (message) => {
        // Handle IPC messages from agent if needed (alternative to TCP)
        logger.info(`[Agent ${globalAgentId} IPC]:`, message);
    });

    logger.info(`Agent ${globalAgentId} spawned with PID ${agentProcess.pid}`);
}

function terminateAgent(globalAgentId: string): void {
    const agent = managedAgents.get(globalAgentId);
    if (agent && agent.status !== 'stopped') {
        logger.info(`Terminating agent ${globalAgentId}...`);
        agent.process.kill('SIGTERM'); // Graceful shutdown first
        // Set a timeout to force kill if it doesn't exit
        setTimeout(() => {
            if (agent.status !== 'stopped') {
                logger.warn(`Agent ${globalAgentId} did not terminate gracefully, sending SIGKILL.`);
                agent.process.kill('SIGKILL');
            }
        }, 5000); // 5 second timeout
    } else {
        logger.info(`Agent ${globalAgentId} not found or already stopped.`);
    }
}

// --- Coordinator -> Agent command routing ---
// Shared by both the inbound WS server handler and the upstream client handler so
// commands behave identically regardless of which side initiated the connection.
// Payloads are validated (design [E]) and undeliverable frames are queued (design [C]).
function routeCoordinatorMessage(
    parsedMessage: { type: string; payload?: unknown },
    commanderId: string
): void {
    switch (parsedMessage.type) {
        case MsgType.AgentCommand: {
            const validated = validatePayload(agentCommandPayloadSchema, parsedMessage.payload);
            if (!validated.ok) {
                logger.warn('Dropping invalid agentCommand payload', { error: validated.error });
                metrics.increment('ws_invalid_payloads');
                return;
            }
            const { agentId, taskId, task, completionCondition } = validated.value as {
                agentId: string;
                taskId: string;
                task: { type: string };
                completionCondition?: unknown;
            };
            const agent = managedAgents.get(agentId);
            if (!agent) {
                logger.warn(`Cannot route command to agent ${agentId}: Agent not found.`);
                return;
            }
            if (agent.commanderId !== commanderId) {
                logger.info(`Assigning commander ${commanderId} to agent ${agentId}`);
                agent.commanderId = commanderId;
            }
            logger.info(`Routing command (Task: ${task.type}) to Agent ${agentId}`);
            sendToAgent(agent, {
                type: TcpMsgType.Command,
                payload: { taskId, task, completionCondition }
            });
            break;
        }
        case MsgType.SpawnAgent: {
            const payload = (parsedMessage.payload ?? {}) as { agentId?: string };
            if (payload.agentId) {
                spawnAgent(payload.agentId);
            } else {
                logger.error('spawnAgent message missing agentId');
            }
            break;
        }
        case MsgType.TerminateAgent: {
            const payload = (parsedMessage.payload ?? {}) as { agentId?: string };
            if (payload.agentId) {
                terminateAgent(payload.agentId);
            } else {
                logger.error('terminateAgent message missing agentId');
            }
            break;
        }
        case MsgType.UpdateProfile: {
            const validated = validatePayload(updateProfilePayloadSchema, parsedMessage.payload);
            if (!validated.ok) {
                logger.warn('Dropping invalid updateProfile payload', { error: validated.error });
                metrics.increment('ws_invalid_payloads');
                return;
            }
            const { agentId, profile } = validated.value as { agentId: string; profile?: unknown };
            const agent = managedAgents.get(agentId);
            if (!agent) {
                logger.warn(`Cannot route profile update to agent ${agentId}: Agent not found.`);
                return;
            }
            logger.info(`Routing profile update to Agent ${agentId}`);
            sendToAgent(agent, { type: TcpMsgType.UpdateProfile, payload: profile });
            break;
        }
        case MsgType.CancelTask: {
            const validated = validatePayload(cancelTaskPayloadSchema, parsedMessage.payload);
            if (!validated.ok) {
                logger.warn('Dropping invalid cancelTask payload', { error: validated.error });
                metrics.increment('ws_invalid_payloads');
                return;
            }
            const { agentId, taskId } = validated.value as { agentId: string; taskId?: string };
            const agent = managedAgents.get(agentId);
            if (!agent) {
                logger.warn(`Cannot route cancelTask to agent ${agentId}: Agent not found.`);
                return;
            }
            logger.info(`Routing cancelTask to Agent ${agentId} (task: ${taskId})`);
            sendToAgent(agent, { type: TcpMsgType.CancelTask, payload: { taskId } });
            break;
        }
        case MsgType.ChatMessage: {
            const validated = validatePayload(chatMessagePayloadSchema, parsedMessage.payload);
            if (!validated.ok) {
                logger.warn('Dropping invalid chatMessage payload', { error: validated.error });
                metrics.increment('ws_invalid_payloads');
                return;
            }
            const { agentId, message: chatMsg } = validated.value as {
                agentId?: string;
                message: string;
            };
            if (!agentId) {
                logger.warn('Cannot route chat message: payload missing agentId.');
                return;
            }
            const agent = managedAgents.get(agentId);
            if (!agent) {
                logger.warn(`Cannot route chat message to agent ${agentId}: Agent not found.`);
                return;
            }
            logger.info(`Routing chat message to Agent ${agentId}`);
            sendToAgent(agent, { type: TcpMsgType.ChatMessage, payload: { message: chatMsg } });
            break;
        }
        default:
            // Unrecognized coordinator message type — ignore.
            break;
    }
}

// --- WebSocket Server (for the Coordinator) ---
const wss = new WebSocketServer({ port: WS_PORT });
logger.info(`BSM WebSocket server listening on port ${WS_PORT}`);

wss.on('connection', (ws: WebSocket) => {
    logger.debug('WS Client connected');
    metrics.increment('ws_connections');
    // First message must be a coordinator registration.

    ws.on('message', (message: Buffer) => {
        // --- Boundary validation (design [E]) ---
        const parsed = parseWsMessage(message);
        if (!parsed.ok) {
            logger.warn('Dropping invalid WS message from client', { error: parsed.error });
            metrics.increment('ws_invalid_messages');
            return;
        }
        const parsedMessage = parsed.value;
        logger.info(`Received WS message type: ${parsedMessage.type} from ${parsedMessage.senderId}`);

        // --- Client Identification ---
        if (!connectedWSClients.has(ws)) {
            if (parsedMessage.type === MsgType.BsmRegister) {
                const clientId = parsedMessage.senderId;
                if (!clientId) {
                    logger.error('Registration message missing senderId');
                    ws.close(1008, 'Missing senderId');
                    return;
                }
                connectedWSClients.set(ws, { ws, type: 'coordinator', id: clientId });
                logger.info(`coordinator registered: ${clientId}`);
                return; // Don't process registration message further
            } else {
                logger.error('First message from client was not registration');
                ws.close(1008, 'Registration required');
                return;
            }
        }

        const clientInfo = connectedWSClients.get(ws);
        if (!clientInfo) return; // Should not happen after registration check

        // --- Message Routing (WS -> Agent) ---
        routeCoordinatorMessage(parsedMessage, clientInfo.id);
    });

    ws.on('close', () => {
        const clientInfo = connectedWSClients.get(ws);
        if (clientInfo) {
            logger.info(`WS Client disconnected: ${clientInfo.type} ${clientInfo.id}`);
            connectedWSClients.delete(ws);
        } else {
            logger.info('Unknown WS Client disconnected');
        }
    });

    ws.on('error', (error: Error) => {
        logger.error('BSM WebSocket error:', error);
        const clientInfo = connectedWSClients.get(ws);
         if (clientInfo) {
            connectedWSClients.delete(ws);
        }
    });
});

// --- Local TCP Server (for Bot Agents) ---
const tcpServer = net.createServer((socket: net.Socket) => {
    logger.debug('Agent connected via TCP');
    metrics.increment('tcp_connections');
    let associatedAgentId: string | null = null;
    let buffer = '';

    let agentIdentified = false;
    let identificationTimeout: NodeJS.Timeout | null = setTimeout(() => {
        if (!agentIdentified) {
            logger.error('Agent identification timeout. Closing connection.');
            socket.end(); // Close the socket if identification fails
        }
    }, 5000); // 5 second timeout for identification

    socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        let boundary = buffer.indexOf('\n');

        while (boundary !== -1) {
            const messageString = buffer.substring(0, boundary);
            buffer = buffer.substring(boundary + 1);
            boundary = buffer.indexOf('\n'); // Pre-advance so `continue` is safe.

            // --- Boundary validation (design [E]) ---
            const parsed = parseTcpMessage(messageString);
            if (!parsed.ok) {
                logger.warn('Dropping invalid TCP frame from agent', {
                    agentId: associatedAgentId || 'Unknown',
                    error: parsed.error
                });
                metrics.increment('tcp_invalid_messages');
                continue;
            }
            const message = parsed.value;
            // The envelope is { v?, type, payload? }; richer agent payloads (events,
            // status snapshots) carry their fields inside `payload`.
            const payload = (message.payload ?? {}) as Record<string, unknown>;
            logger.info(`Received TCP message type: ${message.type} from Agent ${associatedAgentId || 'Unknown'}`);

            // --- Agent Identification & Routing Logic ---
            if (!agentIdentified) {
                // Expecting registration message first.
                if (message.type !== TcpMsgType.Register) {
                    logger.warn('Received non-registration message before agent identification. Ignoring message.');
                    continue;
                }

                // Validate the register payload (design [E]) and auth (design [D]).
                const validated = validatePayload(agentRegisterPayloadSchema, message.payload);
                if (!validated.ok) {
                    logger.warn('Dropping invalid agent register payload', { error: validated.error });
                    metrics.increment('tcp_invalid_payloads');
                    continue;
                }
                const regPayload = validated.value as { agentId: string; authToken?: string };

                if (!checkAuthToken(config.CLUSTER_AUTH_TOKEN, regPayload.authToken)) {
                    logger.warn('Agent auth failed — closing TCP connection', {
                        agentId: regPayload.agentId
                    });
                    metrics.increment('agent_auth_failures');
                    if (identificationTimeout) clearTimeout(identificationTimeout);
                    socket.destroy();
                    return;
                }

                const potentialId = regPayload.agentId;
                let agent = managedAgents.get(potentialId);

                // Auto-register externally started agents.
                if (!agent) {
                    logger.info(`Auto-registering external agent: ${potentialId}`);
                    managedAgents.set(potentialId, {
                        process: null as any,
                        localSocket: null,
                        status: 'starting',
                        commanderId: 'coordinator',
                        globalAgentId: potentialId,
                        outboundQueue: [],
                    });
                    agent = managedAgents.get(potentialId)!;
                    // Re-register with coordinator to include the new agent.
                    registerWithCoordinator();
                }

                if (agent && !agent.localSocket) {
                    associatedAgentId = potentialId;
                    agent.localSocket = socket;
                    agent.status = 'running'; // Mark as running once TCP connection is established
                    agentIdentified = true; // Mark as identified
                    if (identificationTimeout) clearTimeout(identificationTimeout); // Clear timeout
                    logger.info(`Agent ${associatedAgentId} successfully registered and identified.`);
                    // Send ack.
                    socket.write(JSON.stringify({ type: TcpMsgType.RegisterAck, payload: { status: 'Registered' } }) + '\n');
                    // Flush any frames that queued up while the agent was unreachable (design [C]).
                    flushAgentQueue(agent);
                } else {
                    logger.error(`Registration failed for agent ${potentialId}. Already connected.`);
                    if (identificationTimeout) clearTimeout(identificationTimeout);
                    socket.end();
                    return;
                }
                continue;
            }

            // --- Agent is identified — route its message ---
            if (!associatedAgentId) {
                // This state should ideally not be reachable if agentIdentified is true.
                logger.error('Internal state error: Agent identified flag is true but associatedAgentId is null.');
                if (identificationTimeout) clearTimeout(identificationTimeout);
                socket.end(); // Close potentially problematic connection
                return;
            }

            const agent = managedAgents.get(associatedAgentId); // Now safe to use associatedAgentId
            if (!agent) {
                logger.error(`Agent ${associatedAgentId} was identified but not found in managedAgents map. This might happen if terminated concurrently.`);
                continue; // Stop processing this frame if agent is gone
            }

            // --- Command ack relay (design [A] step 4) ---
            // Forward the agent's immediate accept/reject upstream to the coordinator.
            // queueUpstream sends immediately if the WS is open, else buffers it.
            if (message.type === TcpMsgType.CommandAck) {
                queueUpstream(makeWsMessage(MsgType.AgentCommandAck, message.payload, BSM_ID));
                metrics.increment('command_acks_relayed');
                continue;
            }

            // --- Message Routing (Agent -> WS / World State) ---
            // Agent events/status snapshots live inside `payload` and carry a `destination`.
            const destination = payload.destination as string | undefined;
            if (destination) {
                switch (destination) {
                    case 'world_state_service':
                        if ('eventType' in payload) {
                            forwardToWorldState(payload as unknown as AgentEvent);
                        } else {
                            logger.warn(`Received message for world_state_service without eventType from ${associatedAgentId}`);
                        }
                        break;
                    case 'orchestrator':
                    case 'coordinator':
                    case 'commander':
                    case agent.commanderId:
                        forwardToCommander(payload as unknown as AgentEvent | AgentStatusSnapshot, agent.commanderId || 'coordinator');
                        break;
                    default:
                        logger.warn(`Unknown destination '${destination}' for message from agent ${associatedAgentId}`);
                }
            } else {
                logger.warn(`Message from agent ${associatedAgentId} missing destination field.`);
            }
        } // End while loop
    });

    socket.on('close', () => {
        logger.info(`Agent TCP connection closed${associatedAgentId ? ` for ${associatedAgentId}` : ''}`);
        if (associatedAgentId) {
            const agent = managedAgents.get(associatedAgentId);
            if (agent) {
                agent.localSocket = null;
                // Don't necessarily change status here, wait for process exit event
                // agent.status = 'stopped'; // Or maybe 'disconnected'?
            }
        }
    });

    socket.on('error', (err: Error) => {
        logger.error(`Agent TCP socket error${associatedAgentId ? ` for ${associatedAgentId}` : ''}:`, err);
         if (associatedAgentId) {
            const agent = managedAgents.get(associatedAgentId);
            if (agent) {
                agent.localSocket = null;
            }
        }
    });
});

tcpServer.listen(LOCAL_AGENT_PORT, () => {
    logger.info('BSM TCP server listening for agents', { port: LOCAL_AGENT_PORT });
});

// --- Upstream WebSocket Client (BSM -> Coordinator) ---
let upstreamWs: WebSocket | null = null;
let upstreamReconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Bounded buffer for upstream->coordinator frames while the WS is down (design [C]).
const upstreamQueue: string[] = [];

/** (Re)register this BSM with the coordinator if the upstream WS is open. */
function registerWithCoordinator(): void {
    if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) return;
    const agentList = Array.from(managedAgents.entries()).map(([id, a]) => ({
        agentId: id,
        status: a.status,
    }));
    const registerMsg = makeWsMessage(
        MsgType.BsmRegister,
        {
            bsmId: BSM_ID,
            address: `ws://localhost:${WS_PORT}`,
            capacity: 10,
            agents: agentList,
            authToken: config.CLUSTER_AUTH_TOKEN,
        },
        BSM_ID
    );
    upstreamWs.send(JSON.stringify(registerMsg));
    logger.info('BSM (re)registered with coordinator', {
        bsmId: BSM_ID,
        agents: agentList.length
    });
}

/**
 * Send a frame upstream to the coordinator. If the WS is not open, buffer it
 * (bounded FIFO; oldest dropped with a warning on overflow) and flush on reconnect.
 */
function queueUpstream(frame: object): void {
    const line = JSON.stringify(frame);
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(line);
        return;
    }
    if (upstreamQueue.length >= UPSTREAM_QUEUE_CAP) {
        upstreamQueue.shift();
        logger.warn('Upstream queue full — dropping oldest frame', { cap: UPSTREAM_QUEUE_CAP });
        metrics.increment('upstream_dropped');
    }
    upstreamQueue.push(line);
    metrics.increment('upstream_queued');
}

/** Flush buffered upstream frames once the coordinator WS is open again. */
function flushUpstreamQueue(): void {
    if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) return;
    if (upstreamQueue.length === 0) return;
    logger.info('Flushing buffered upstream frames to coordinator', { count: upstreamQueue.length });
    while (upstreamQueue.length > 0) {
        upstreamWs.send(upstreamQueue.shift()!);
        metrics.increment('upstream_flushed');
    }
}

function connectToCoordinator(): void {
    if (upstreamWs && (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING)) {
        return;
    }

    logger.info(`Connecting to coordinator at ${COORDINATOR_ADDRESS}...`);
    upstreamWs = new WebSocket(COORDINATOR_ADDRESS);

    upstreamWs.on('open', () => {
        logger.info('Connected to coordinator');
        // Register this BSM with the coordinator.
        registerWithCoordinator();
        // Also register the upstream connection as the coordinator client in
        // connectedWSClients so forwardToCommander can find it.
        connectedWSClients.set(upstreamWs!, { ws: upstreamWs!, type: 'coordinator', id: 'coordinator' });
        // Flush anything buffered while we were disconnected.
        flushUpstreamQueue();
    });

    upstreamWs.on('message', (data: Buffer) => {
        // --- Boundary validation (design [E]) ---
        const parsed = parseWsMessage(data);
        if (!parsed.ok) {
            logger.warn('Dropping invalid upstream message', { error: parsed.error });
            metrics.increment('ws_invalid_messages');
            return;
        }
        logger.info(`Received upstream message: ${parsed.value.type}`);
        // Same routing as the inbound WS server handler.
        routeCoordinatorMessage(parsed.value, 'coordinator');
    });

    upstreamWs.on('close', () => {
        logger.warn('Upstream coordinator connection closed');
        connectedWSClients.delete(upstreamWs!);
        upstreamWs = null;
        scheduleReconnect();
    });

    upstreamWs.on('error', (error: Error) => {
        logger.error('Upstream coordinator connection error', { error: error.message });
        // close event will fire after this, triggering reconnect
    });
}

function scheduleReconnect(): void {
    if (upstreamReconnectTimer) return;
    upstreamReconnectTimer = setTimeout(() => {
        upstreamReconnectTimer = null;
        connectToCoordinator();
    }, 3000);
}

// Start upstream connection after a short delay to let the local servers initialize
setTimeout(() => connectToCoordinator(), 500);

// --- Health Check Setup ---
const healthCheck = new HealthCheck('bot-server-manager', '0.1.0');

healthCheck.registerDependency('coordinator', async () => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
        return { status: 'connected' };
    }
    // Fallback: check if the coordinator connected to us via the WS server.
    for (const client of connectedWSClients.values()) {
        if (client.type === 'coordinator') {
            return { status: 'connected' };
        }
    }
    return { status: 'disconnected', error: 'No coordinator connection' };
});

healthCheck.registerDependency('world-state-service', async () => {
    try {
        const response = await fetch(`${WORLD_STATE_API_ADDRESS}/health`, { signal: AbortSignal.timeout(5000) });
        return response.ok ? { status: 'connected' } : { status: 'disconnected', error: 'World State unhealthy' };
    } catch (error) {
        return { status: 'disconnected', error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// --- HTTP Server for Health and Metrics ---
const HTTP_PORT = parseInt(process.env.BSM_HTTP_PORT || '4002', 10);
const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health check endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
        try {
            const health = await healthCheck.check();
            const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(health));
        } catch (error) {
            logger.error('Health check failed', { error });
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                service: 'bot-server-manager',
                status: 'unhealthy',
                error: error instanceof Error ? error.message : 'Unknown error'
            }));
        }
        return;
    }

    // Metrics endpoint
    if (url.pathname === '/metrics' && req.method === 'GET') {
        const allMetrics = metrics.getAllMetrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(allMetrics));
        return;
    }

    // Status endpoint (default)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'BSM Running',
        bsmId: BSM_ID,
        managedAgents: managedAgents.size,
        connectedClients: connectedWSClients.size
    }));
});

httpServer.listen(HTTP_PORT, () => {
    logger.info('BSM HTTP server listening', {
      port: HTTP_PORT,
      endpoints: ['/health', '/metrics', '/']
    });
});

// --- Helper Functions for Routing ---

function forwardToWorldState(message: AgentEvent): void {
    logger.debug('Forwarding message to World State Service', {
      eventType: message.eventType,
      agentId: message.agentId
    });
    const startTime = Date.now();

    // Use HTTP POST to send the report payload
    const reportPayload: WorldStateReportPayload | null = mapAgentEventToWorldStateReport(message);

    if (!reportPayload) {
        logger.warn('Could not map agent event to World State report', {
          eventType: message.eventType,
          agentId: message.agentId
        });
        metrics.increment('world_state_mapping_failures');
        return;
    }

    fetch(`${WORLD_STATE_API_ADDRESS}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportPayload)
    })
    .then(response => {
        if (!response.ok) {
            logger.error('Error reporting to World State Service', {
              status: response.status,
              statusText: response.statusText,
              dataType: reportPayload.dataType
            });
            metrics.increment('world_state_report_errors');
        } else {
             logger.debug('Successfully reported to World State Service', {
               dataType: reportPayload.dataType
             });
             metrics.increment('world_state_reports_sent');
             metrics.record('world_state_report_time', Date.now() - startTime);
        }
    })
    .catch(error => {
        logger.error('Fetch error reporting to World State Service', { error });
        metrics.increment('world_state_report_errors');
    });
}

function forwardToCommander(message: AgentEvent | AgentStatusSnapshot, commanderId: string): void {
    // Use type guard to determine the correct property for logging
    const messageType = 'eventType' in message ? `AgentEvent (${message.eventType})` : 'AgentStatusSnapshot';
    logger.debug('Forwarding message to commander', {
      messageType,
      agentId: message.agentId,
      commanderId
    });

    let targetClient: ConnectedClient | null = null;

    for (const client of connectedWSClients.values()) {
        if (client.id === commanderId) {
            targetClient = client;
            break;
        }
    }

    // Build the versioned WS envelope using protocol constants.
    const wsType = 'eventType' in message
        ? agentEventType(message.eventType)
        : MsgType.AgentStatusUpdate;
    const wsMessage = makeWsMessage(wsType, message, BSM_ID);

    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
        targetClient.ws.send(JSON.stringify(wsMessage));
        metrics.increment('messages_forwarded_to_commander');
    } else if (commanderId === 'coordinator') {
        // The coordinator is our upstream — buffer the frame so it is delivered on
        // reconnect rather than silently dropped (design [C]).
        logger.warn('Coordinator not reachable — buffering forwarded frame', { commanderId });
        queueUpstream(wsMessage);
        metrics.increment('message_forwarding_buffered');
    } else {
        logger.warn('Cannot forward message to commander: Client not found or connection not open', {
          commanderId
        });
        metrics.increment('message_forwarding_failures');
    }
}

// --- Mapping Function (Agent Event -> World State Report) ---
// This needs to be expanded based on which agent events trigger world state updates
function mapAgentEventToWorldStateReport(event: AgentEvent): WorldStateReportPayload | null {
    const baseReport = {
        reporterAgentId: event.agentId,
        timestamp: event.timestamp,
    };

    if (event.eventType === 'foundPOI' && event.details && 'poiType' in event.details) {
        return {
            ...baseReport,
            dataType: 'poi',
            data: {
                type: event.details.poiType,
                coords: event.details.location,
                name: event.details.name,
                details: event.details.details,
                // biome: event.details.biome // Add if agent reports biome
            }
        };
    } else if (event.eventType === 'foundResource' && event.details && 'resourceType' in event.details) {
         return {
            ...baseReport,
            dataType: 'resourceNode',
            data: {
                resourceType: event.details.resourceType,
                coords: event.details.location,
                quantityEstimate: event.details.quantityEstimate,
                // depleted: false // Initial report is not depleted
            }
        };
    }
    // Add mappings for other relevant events if needed (e.g., agent builds infrastructure)

    return null; // Return null if the event type doesn't map to a report
}


// --- Initial Agent Spawning (Example - replace with Orchestrator commands) ---
// spawnAgent('agent-001');
// spawnAgent('agent-002');

// --- Graceful Shutdown ---
const shutdown = createGracefulShutdown(logger);

shutdown.register(async () => {
    logger.info('Closing WebSocket server...');
    wss.close();
});

shutdown.register(async () => {
    logger.info('Closing TCP server...');
    return new Promise<void>((resolve) => {
        tcpServer.close(() => {
            logger.info('TCP server closed');
            resolve();
        });
    });
});

shutdown.register(async () => {
    logger.info('Closing HTTP server...');
    return new Promise<void>((resolve) => {
        httpServer.close(() => {
            logger.info('HTTP server closed');
            resolve();
        });
    });
});

shutdown.register(async () => {
    logger.info('Terminating all managed agents...');
    const terminationPromises = Array.from(managedAgents.keys()).map(agentId => {
        return new Promise<void>(resolve => {
            const agent = managedAgents.get(agentId);
            if (agent && agent.status !== 'stopped') {
                agent.process.on('exit', () => resolve());
                terminateAgent(agentId);
                 // Add a timeout in case termination hangs
                setTimeout(() => {
                    if (agent.status !== 'stopped') {
                         logger.warn('Force shutdown timeout for agent', { agentId });
                         resolve(); // Resolve anyway to not block shutdown
                    }
                }, 6000); // Slightly longer than terminateAgent timeout
            } else {
                resolve();
            }
        });
    });
    await Promise.all(terminationPromises);
    logger.info('All agents terminated');
});