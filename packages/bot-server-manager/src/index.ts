import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import net from 'net';
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import {
  WebSocketMessage,
  AgentStatusSnapshot,
  AgentEvent,
  WorldStateReportPayload,
  createLogger,
  validateConfig,
  bsmConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  HealthChecks,
  metrics
} from '@aetherius/shared-types';

// --- Initialize Logger ---
const logger = createLogger('bot-server-manager');

// --- Validate Configuration ---
const config = validateConfig(bsmConfigSchema, 'Bot Server Manager');

const WS_PORT = config.BSM_WS_PORT;
const LOCAL_AGENT_PORT = config.BSM_AGENT_PORT;
const ORCHESTRATOR_ADDRESS = config.ORCHESTRATOR_ADDRESS;
const WORLD_STATE_API_ADDRESS = config.WORLD_STATE_API_ADDRESS;
const BSM_ID = config.BSM_ID || `bsm-${Math.random().toString(36).substring(2, 8)}`;
const AGENT_SCRIPT_PATH = config.AGENT_SCRIPT_PATH || '../bot-agent/dist/index.js';

logger.info('Starting Bot Server Manager', {
  bsmId: BSM_ID,
  wsPort: WS_PORT,
  agentPort: LOCAL_AGENT_PORT,
  orchestratorAddress: ORCHESTRATOR_ADDRESS,
  worldStateApi: WORLD_STATE_API_ADDRESS,
  agentScriptPath: AGENT_SCRIPT_PATH
});

// --- State ---
interface ManagedAgent {
    process: ChildProcess;
    localSocket: net.Socket | null;
    status: 'starting' | 'running' | 'stopped' | 'errored';
    commanderId: string | null; // Orchestrator or SquadLeader ID
    globalAgentId: string; // The ID known by the Orchestrator
}
const managedAgents: Map<string, ManagedAgent> = new Map(); // Key: globalAgentId

interface ConnectedClient {
    ws: WebSocket;
    type: 'orchestrator' | 'squadLeader';
    id: string; // Orchestrator ID or SquadLeader ID
}
const connectedWSClients: Map<WebSocket, ConnectedClient> = new Map(); // Key: WebSocket instance

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

// --- WebSocket Server (for Orchestrator, Squad Leaders) ---
const wss = new WebSocketServer({ port: WS_PORT });
logger.info(`BSM WebSocket server listening on port ${WS_PORT}`);

wss.on('connection', (ws: WebSocket) => {
    logger.debug('WS Client connected');
    metrics.increment('ws_connections');
    // TODO: Implement authentication/identification handshake
    // For now, assume first message identifies the client

    ws.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            logger.info(`Received WS message type: ${parsedMessage.type} from ${parsedMessage.senderId}`);

            // --- Client Identification ---
            if (!connectedWSClients.has(ws)) {
                 if (parsedMessage.type === 'orchestrator::register' || parsedMessage.type === 'squadLeader::register') {
                    const clientId = parsedMessage.senderId;
                    if (!clientId) {
                        logger.error('Registration message missing senderId');
                        ws.close(1008, 'Missing senderId');
                        return;
                    }
                    const clientType = parsedMessage.type.startsWith('orchestrator') ? 'orchestrator' : 'squadLeader';
                    connectedWSClients.set(ws, { ws, type: clientType, id: clientId });
                    logger.info(`${clientType} registered: ${clientId}`);
                    // Send confirmation?
                    // ws.send(JSON.stringify({ type: 'bsm::registerAck', payload: { bsmId: BSM_ID } }));
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
            if (parsedMessage.type === 'squadLeader::agentCommand' || parsedMessage.type === 'orchestrator::agentCommand') {
                const { agentId, taskId, task } = parsedMessage.payload;
                const agent = managedAgents.get(agentId);

                if (agent && agent.localSocket && agent.status === 'running') {
                    logger.info(`Routing command ${parsedMessage.type} (Task: ${task.type}) to Agent ${agentId}`);
                    // Assign commander if not already set or changed
                    if (agent.commanderId !== clientInfo.id) {
                        logger.info(`Assigning commander ${clientInfo.id} to agent ${agentId}`);
                        agent.commanderId = clientInfo.id;
                    }
                    // Forward the command payload over TCP to the specific agent
                    const messageToSend = JSON.stringify({ type: 'command', payload: { taskId, task } });
                    agent.localSocket.write(messageToSend + '\n'); // Add newline as delimiter
                } else {
                    logger.warn(`Cannot route command to agent ${agentId}: Agent not found, not connected via TCP, or not running.`);
                    // TODO: Send error back to commander?
                }
            } else if (parsedMessage.type === 'orchestrator::spawnAgent') {
                 const { agentId: agentToSpawn } = parsedMessage.payload;
                 if (agentToSpawn) {
                     spawnAgent(agentToSpawn);
                 } else {
                     logger.error('orchestrator::spawnAgent message missing agentId');
                 }
            } else if (parsedMessage.type === 'orchestrator::terminateAgent') {
                 const { agentId: agentToTerminate } = parsedMessage.payload;
                 if (agentToTerminate) {
                     terminateAgent(agentToTerminate);
                 } else {
                      logger.error('orchestrator::terminateAgent message missing agentId');
                 }
            }
            // Add handlers for other WS message types if needed

        } catch (error) {
            logger.error('Failed to parse WS message or handle:', error);
        }
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

            try {
                const message: AgentEvent | AgentStatusSnapshot | { type: 'register', payload: { agentId: string } } = JSON.parse(messageString);
                // Log based on identified type
                if ('type' in message && message.type === 'register') {
                    logger.info(`Received TCP message type: register from Agent ${associatedAgentId || 'Unknown'}`);
                } else if ('eventType' in message) {
                     logger.info(`Received TCP message type: AgentEvent (${message.eventType}) from Agent ${associatedAgentId}`);
                } else if ('status' in message) { // Assuming AgentStatusSnapshot has a 'status' field
                     logger.info(`Received TCP message type: AgentStatusSnapshot from Agent ${associatedAgentId}`);
                } else {
                     logger.info(`Received unknown TCP message structure from Agent ${associatedAgentId || 'Unknown'}`);
                }

                // --- Agent Identification & Routing Logic ---
                if (!agentIdentified) {
                    // Expecting registration message first
                    if ('type' in message && message.type === 'register' && 'payload' in message && message.payload.agentId) {
                        const potentialId = message.payload.agentId;
                        const agent = managedAgents.get(potentialId);
                        if (agent && !agent.localSocket) { // Check if agent exists and isn't already associated
                            associatedAgentId = potentialId;
                            agent.localSocket = socket;
                            agent.status = 'running'; // Mark as running once TCP connection is established
                            agentIdentified = true; // Mark as identified
                            if (identificationTimeout) clearTimeout(identificationTimeout); // Clear timeout
                            logger.info(`Agent ${associatedAgentId} successfully registered and identified.`);
                            // Send ack
                            socket.write(JSON.stringify({ type: 'bsm::registerAck', payload: { status: 'Registered' } }) + '\n');
                        } else {
                            logger.error(`Registration failed for agent ${potentialId}. Agent not managed by this BSM or already connected.`);
                            if (identificationTimeout) clearTimeout(identificationTimeout);
                            socket.end(); // Disconnect unidentified or duplicate agent
                            return; // Stop processing this message chunk
                        }
                    } else {
                        // Received a non-registration message before identification
                        logger.warn('Received non-registration message before agent identification. Ignoring message.');
                        // Optionally close connection if strict identification is required first:
                        // if (identificationTimeout) clearTimeout(identificationTimeout);
                        // socket.end();
                        // return;
                    }
                } else {
                    // Agent is already identified, proceed with message routing
                    if (!associatedAgentId) {
                        // This state should ideally not be reachable if agentIdentified is true
                        logger.error('Internal state error: Agent identified flag is true but associatedAgentId is null.');
                        if (identificationTimeout) clearTimeout(identificationTimeout);
                        socket.end(); // Close potentially problematic connection
                        return;
                    }

                    const agent = managedAgents.get(associatedAgentId); // Now safe to use associatedAgentId
                    if (!agent) {
                        logger.error(`Agent ${associatedAgentId} was identified but not found in managedAgents map. This might happen if terminated concurrently.`);
                        return; // Stop processing if agent is gone
                    }

                    // --- Message Routing (Agent -> WS / World State) ---
                    if ('destination' in message) {
                        switch (message.destination) {
                            case 'world_state_service':
                                // Ensure it's an AgentEvent before forwarding
                                if ('eventType' in message) {
                                    forwardToWorldState(message);
                                } else {
                                    logger.warn(`Received message for world_state_service without eventType from ${associatedAgentId}`);
                                }
                                break;
                            case 'orchestrator':
                            case agent.commanderId: // Route to current commander (Squad Leader or Orchestrator)
                                if (agent.commanderId === message.destination || message.destination === 'orchestrator') {
                                    forwardToCommander(message, message.destination);
                                } else {
                                     logger.warn(`Message from ${associatedAgentId} has destination ${message.destination} which does not match current commander ${agent.commanderId}`);
                                }
                                break;
                            default:
                                logger.warn(`Unknown destination '${message.destination}' for message from agent ${associatedAgentId}`);
                        }
                    } else {
                         logger.warn(`Message from agent ${associatedAgentId} missing destination field.`);
                    }
                } // End of identified agent message handling
            } catch (error) {
                logger.error('Failed to parse TCP message or handle:', error, `\nRaw data part: ${messageString}`);
            }
            boundary = buffer.indexOf('\n'); // Check for next message in buffer
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

// --- Health Check Setup ---
const healthCheck = new HealthCheck('bot-server-manager', '0.1.0');

healthCheck.registerDependency('orchestrator', async () => {
    // Check if orchestrator WebSocket is connected
    for (const client of connectedWSClients.values()) {
        if (client.type === 'orchestrator') {
            return { status: 'connected' };
        }
    }
    return { status: 'disconnected', error: 'No orchestrator connection' };
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

    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
        // Construct the WebSocket message to forward
        const wsMessage: WebSocketMessage = {
            // Use type guard to construct the correct type string
            type: 'eventType' in message ? `agent::event::${message.eventType}` : `agent::statusUpdate`,
            payload: message, // Forward the original agent message payload
            senderId: BSM_ID // Identify this BSM as the forwarder
        };
        targetClient.ws.send(JSON.stringify(wsMessage));
        metrics.increment('messages_forwarded_to_commander');
    } else {
        logger.warn('Cannot forward message to commander: Client not found or connection not open', {
          commanderId
        });
        metrics.increment('message_forwarding_failures');
        // TODO: Handle undeliverable message? Queue? Notify agent?
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