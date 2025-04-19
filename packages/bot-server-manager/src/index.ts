import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import net from 'net';
import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { WebSocketMessage, AgentStatusSnapshot, AgentEvent, WorldStateReportPayload } from '@aetherius/shared-types'; // Assuming shared types are set up

// --- Configuration (Replace with actual config loading) ---
const WS_PORT = parseInt(process.env.BSM_WS_PORT || '4000', 10);
const LOCAL_AGENT_PORT = parseInt(process.env.BSM_AGENT_PORT || '4001', 10);
const ORCHESTRATOR_ADDRESS = process.env.ORCHESTRATOR_ADDRESS || 'ws://localhost:????'; // TODO: Get Orchestrator WS port
const WORLD_STATE_API_ADDRESS = process.env.WORLD_STATE_API_ADDRESS || 'http://localhost:3000'; // Assuming default WSS port
const BSM_ID = process.env.BSM_ID || `bsm-${Math.random().toString(36).substring(2, 8)}`;
const AGENT_SCRIPT_PATH = process.env.AGENT_SCRIPT_PATH || '../bot-agent/dist/index.js'; // Relative path to compiled agent script

console.log(`--- Bot Server Manager (${BSM_ID}) ---`);
console.log(`WebSocket Port: ${WS_PORT}`);
console.log(`Local Agent TCP Port: ${LOCAL_AGENT_PORT}`);
console.log(`Orchestrator Address: ${ORCHESTRATOR_ADDRESS}`);
console.log(`World State API Address: ${WORLD_STATE_API_ADDRESS}`);
console.log(`Agent Script Path: ${AGENT_SCRIPT_PATH}`);

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
    console.log(`Spawning agent process for ${globalAgentId}...`);
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

    agentProcess.stdout?.on('data', (data) => {
        console.log(`[Agent ${globalAgentId} STDOUT]: ${data.toString().trim()}`);
    });

    agentProcess.stderr?.on('data', (data) => {
        console.error(`[Agent ${globalAgentId} STDERR]: ${data.toString().trim()}`);
    });

    agentProcess.on('error', (err) => {
        console.error(`Agent ${globalAgentId} process error:`, err);
        agent.status = 'errored';
        // TODO: Implement restart logic? Notify Orchestrator?
    });

    agentProcess.on('exit', (code, signal) => {
        console.log(`Agent ${globalAgentId} process exited with code ${code}, signal ${signal}`);
        agent.status = 'stopped';
        if (agent.localSocket && !agent.localSocket.destroyed) {
            agent.localSocket.destroy();
        }
        managedAgents.delete(globalAgentId);
        // TODO: Notify Orchestrator/Commander?
    });

     agentProcess.on('message', (message) => {
        // Handle IPC messages from agent if needed (alternative to TCP)
        console.log(`[Agent ${globalAgentId} IPC]:`, message);
    });

    console.log(`Agent ${globalAgentId} spawned with PID ${agentProcess.pid}`);
}

function terminateAgent(globalAgentId: string): void {
    const agent = managedAgents.get(globalAgentId);
    if (agent && agent.status !== 'stopped') {
        console.log(`Terminating agent ${globalAgentId}...`);
        agent.process.kill('SIGTERM'); // Graceful shutdown first
        // Set a timeout to force kill if it doesn't exit
        setTimeout(() => {
            if (agent.status !== 'stopped') {
                console.warn(`Agent ${globalAgentId} did not terminate gracefully, sending SIGKILL.`);
                agent.process.kill('SIGKILL');
            }
        }, 5000); // 5 second timeout
    } else {
        console.log(`Agent ${globalAgentId} not found or already stopped.`);
    }
}

// --- WebSocket Server (for Orchestrator, Squad Leaders) ---
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`BSM WebSocket server listening on port ${WS_PORT}`);

wss.on('connection', (ws: WebSocket) => {
    console.log('WS Client connected');
    // TODO: Implement authentication/identification handshake
    // For now, assume first message identifies the client

    ws.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            console.log(`Received WS message type: ${parsedMessage.type} from ${parsedMessage.senderId}`);

            // --- Client Identification ---
            if (!connectedWSClients.has(ws)) {
                 if (parsedMessage.type === 'orchestrator::register' || parsedMessage.type === 'squadLeader::register') {
                    const clientId = parsedMessage.senderId;
                    if (!clientId) {
                        console.error('Registration message missing senderId');
                        ws.close(1008, 'Missing senderId');
                        return;
                    }
                    const clientType = parsedMessage.type.startsWith('orchestrator') ? 'orchestrator' : 'squadLeader';
                    connectedWSClients.set(ws, { ws, type: clientType, id: clientId });
                    console.log(`${clientType} registered: ${clientId}`);
                    // Send confirmation?
                    // ws.send(JSON.stringify({ type: 'bsm::registerAck', payload: { bsmId: BSM_ID } }));
                    return; // Don't process registration message further
                } else {
                    console.error('First message from client was not registration');
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
                    console.log(`Routing command ${parsedMessage.type} (Task: ${task.type}) to Agent ${agentId}`);
                    // Assign commander if not already set or changed
                    if (agent.commanderId !== clientInfo.id) {
                        console.log(`Assigning commander ${clientInfo.id} to agent ${agentId}`);
                        agent.commanderId = clientInfo.id;
                    }
                    // Forward the command payload over TCP to the specific agent
                    const messageToSend = JSON.stringify({ type: 'command', payload: { taskId, task } });
                    agent.localSocket.write(messageToSend + '\n'); // Add newline as delimiter
                } else {
                    console.warn(`Cannot route command to agent ${agentId}: Agent not found, not connected via TCP, or not running.`);
                    // TODO: Send error back to commander?
                }
            } else if (parsedMessage.type === 'orchestrator::spawnAgent') {
                 const { agentId: agentToSpawn } = parsedMessage.payload;
                 if (agentToSpawn) {
                     spawnAgent(agentToSpawn);
                 } else {
                     console.error('orchestrator::spawnAgent message missing agentId');
                 }
            } else if (parsedMessage.type === 'orchestrator::terminateAgent') {
                 const { agentId: agentToTerminate } = parsedMessage.payload;
                 if (agentToTerminate) {
                     terminateAgent(agentToTerminate);
                 } else {
                      console.error('orchestrator::terminateAgent message missing agentId');
                 }
            }
            // Add handlers for other WS message types if needed

        } catch (error) {
            console.error('Failed to parse WS message or handle:', error);
        }
    });

    ws.on('close', () => {
        const clientInfo = connectedWSClients.get(ws);
        if (clientInfo) {
            console.log(`WS Client disconnected: ${clientInfo.type} ${clientInfo.id}`);
            connectedWSClients.delete(ws);
        } else {
            console.log('Unknown WS Client disconnected');
        }
    });

    ws.on('error', (error: Error) => {
        console.error('BSM WebSocket error:', error);
        const clientInfo = connectedWSClients.get(ws);
         if (clientInfo) {
            connectedWSClients.delete(ws);
        }
    });
});

// --- Local TCP Server (for Bot Agents) ---
const tcpServer = net.createServer((socket: net.Socket) => {
    console.log('Agent connected via TCP');
    let associatedAgentId: string | null = null;
    let buffer = '';

    let agentIdentified = false;
    let identificationTimeout: NodeJS.Timeout | null = setTimeout(() => {
        if (!agentIdentified) {
            console.error('Agent identification timeout. Closing connection.');
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
                    console.log(`Received TCP message type: register from Agent ${associatedAgentId || 'Unknown'}`);
                } else if ('eventType' in message) {
                     console.log(`Received TCP message type: AgentEvent (${message.eventType}) from Agent ${associatedAgentId}`);
                } else if ('status' in message) { // Assuming AgentStatusSnapshot has a 'status' field
                     console.log(`Received TCP message type: AgentStatusSnapshot from Agent ${associatedAgentId}`);
                } else {
                     console.log(`Received unknown TCP message structure from Agent ${associatedAgentId || 'Unknown'}`);
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
                            console.log(`Agent ${associatedAgentId} successfully registered and identified.`);
                            // Send ack
                            socket.write(JSON.stringify({ type: 'bsm::registerAck', payload: { status: 'Registered' } }) + '\n');
                        } else {
                            console.error(`Registration failed for agent ${potentialId}. Agent not managed by this BSM or already connected.`);
                            if (identificationTimeout) clearTimeout(identificationTimeout);
                            socket.end(); // Disconnect unidentified or duplicate agent
                            return; // Stop processing this message chunk
                        }
                    } else {
                        // Received a non-registration message before identification
                        console.warn('Received non-registration message before agent identification. Ignoring message.');
                        // Optionally close connection if strict identification is required first:
                        // if (identificationTimeout) clearTimeout(identificationTimeout);
                        // socket.end();
                        // return;
                    }
                } else {
                    // Agent is already identified, proceed with message routing
                    if (!associatedAgentId) {
                        // This state should ideally not be reachable if agentIdentified is true
                        console.error('Internal state error: Agent identified flag is true but associatedAgentId is null.');
                        if (identificationTimeout) clearTimeout(identificationTimeout);
                        socket.end(); // Close potentially problematic connection
                        return;
                    }

                    const agent = managedAgents.get(associatedAgentId); // Now safe to use associatedAgentId
                    if (!agent) {
                        console.error(`Agent ${associatedAgentId} was identified but not found in managedAgents map. This might happen if terminated concurrently.`);
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
                                    console.warn(`Received message for world_state_service without eventType from ${associatedAgentId}`);
                                }
                                break;
                            case 'orchestrator':
                            case agent.commanderId: // Route to current commander (Squad Leader or Orchestrator)
                                if (agent.commanderId === message.destination || message.destination === 'orchestrator') {
                                    forwardToCommander(message, message.destination);
                                } else {
                                     console.warn(`Message from ${associatedAgentId} has destination ${message.destination} which does not match current commander ${agent.commanderId}`);
                                }
                                break;
                            default:
                                console.warn(`Unknown destination '${message.destination}' for message from agent ${associatedAgentId}`);
                        }
                    } else {
                         console.warn(`Message from agent ${associatedAgentId} missing destination field.`);
                    }
                } // End of identified agent message handling
            } catch (error) {
                console.error('Failed to parse TCP message or handle:', error, `\nRaw data part: ${messageString}`);
            }
            boundary = buffer.indexOf('\n'); // Check for next message in buffer
        } // End while loop
    });

    socket.on('close', () => {
        console.log(`Agent TCP connection closed${associatedAgentId ? ` for ${associatedAgentId}` : ''}`);
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
        console.error(`Agent TCP socket error${associatedAgentId ? ` for ${associatedAgentId}` : ''}:`, err);
         if (associatedAgentId) {
            const agent = managedAgents.get(associatedAgentId);
            if (agent) {
                agent.localSocket = null;
            }
        }
    });
});

tcpServer.listen(LOCAL_AGENT_PORT, () => {
    console.log(`BSM TCP server listening for agents on port ${LOCAL_AGENT_PORT}`);
});

// --- Helper Functions for Routing ---

function forwardToWorldState(message: AgentEvent): void {
    console.log(`Forwarding message type ${message.eventType} from ${message.agentId} to World State Service`);
    // Use HTTP POST to send the report payload
    const reportPayload: WorldStateReportPayload | null = mapAgentEventToWorldStateReport(message);

    if (!reportPayload) {
        console.warn(`Could not map agent event type ${message.eventType} to a World State report.`);
        return;
    }

    fetch(`${WORLD_STATE_API_ADDRESS}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportPayload)
    })
    .then(response => {
        if (!response.ok) {
            console.error(`Error reporting to World State Service: ${response.status} ${response.statusText}`);
            // Handle error - maybe retry?
        } else {
             console.log(`Successfully reported ${reportPayload.dataType} to World State Service.`);
        }
    })
    .catch(error => {
        console.error('Fetch error reporting to World State Service:', error);
        // Handle fetch error
    });
}

function forwardToCommander(message: AgentEvent | AgentStatusSnapshot, commanderId: string): void {
    // Use type guard to determine the correct property for logging
    const messageType = 'eventType' in message ? `AgentEvent (${message.eventType})` : 'AgentStatusSnapshot';
    console.log(`Forwarding ${messageType} from ${message.agentId} to Commander ${commanderId}`);
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
    } else {
        console.warn(`Cannot forward message to commander ${commanderId}: Client not found or connection not open.`);
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
function shutdown() {
    console.log('Shutting down BSM...');
    // 1. Close servers
    wss.close(() => console.log('WebSocket server closed.'));
    tcpServer.close(() => console.log('TCP server closed.'));

    // 2. Terminate managed agents
    console.log('Terminating managed agents...');
    const terminationPromises = Array.from(managedAgents.keys()).map(agentId => {
        return new Promise<void>(resolve => {
            const agent = managedAgents.get(agentId);
            if (agent && agent.status !== 'stopped') {
                agent.process.on('exit', () => resolve());
                terminateAgent(agentId);
                 // Add a timeout in case termination hangs
                setTimeout(() => {
                    if (agent.status !== 'stopped') {
                         console.warn(`Force shutdown timeout for agent ${agentId}`);
                         resolve(); // Resolve anyway to not block shutdown
                    }
                }, 6000); // Slightly longer than terminateAgent timeout
            } else {
                resolve();
            }
        });
    });

    Promise.all(terminationPromises).then(() => {
        console.log('All agent termination processes initiated or complete.');
        process.exit(0);
    }).catch(err => {
         console.error("Error during agent termination:", err);
         process.exit(1);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);