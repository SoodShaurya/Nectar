import WebSocket from 'ws';
// import { GoogleGenerativeAI } from '@google/generative-ai'; // Uncomment when implementing LLM
import {
    WebSocketMessage,
    AgentInfo,
    SquadInfo,
    TaskObject,
    AgentCommandObject,
    AgentStatusSnapshot,
    AgentEvent
} from '@aetherius/shared-types';

// --- Configuration (Passed via args/env from Orchestrator) ---
const SQUAD_ID = process.env.SQUAD_ID || `squad-unknown-${Math.random().toString(36).substring(2, 8)}`;
const ORCHESTRATOR_ADDRESS = process.env.ORCHESTRATOR_ADDRESS; // Required
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Uncomment when implementing LLM

if (!ORCHESTRATOR_ADDRESS) {
    console.error("FATAL: ORCHESTRATOR_ADDRESS environment variable not set.");
    process.exit(1);
}

console.log(`--- Squad Leader Instance (${SQUAD_ID}) ---`);
console.log(`Orchestrator Address: ${ORCHESTRATOR_ADDRESS}`);

// --- State ---
let missionDescription: string | null = null;
let taskDetails: any = null;
let assignedAgents: Map<string, { agentId: string; bsmAddress: string; bsmSocket: WebSocket | null; statusSummary: Partial<AgentStatusSnapshot['status']> }> = new Map(); // Key: agentId
let orchestratorSocket: WebSocket | null = null;
let isInitialized = false;

// --- LLM Tactical Core (Placeholder) ---
// const genAI = new GoogleGenerativeAI(GEMINI_API_KEY!);
// const tacticalModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); // Or specific version
async function runTacticalPlanning(triggeringEvent?: any) {
    if (!isInitialized) return; // Don't plan before init
    console.log(`Running tactical planning for Squad ${SQUAD_ID} (Placeholder)...`, { triggeringEvent });
    // TODO: Build context (Mission, Agent Summaries, Recent Events)
    // TODO: Interact with Gemini Flash using function calling (agentCommandBatch, reportStatus, reportFind, declareComplete, declareFailed)
    // TODO: Parse response and trigger actions (sendCommandBatch, sendStatusToOrchestrator, etc.)
}

// --- Command Dispatch ---
function sendCommandBatch(commands: AgentCommandObject[]) {
    console.log(`Dispatching command batch for Squad ${SQUAD_ID}:`, commands.map(c => `${c.task.type} to ${c.agentId}`));
    commands.forEach(cmd => {
        const agentInfo = assignedAgents.get(cmd.agentId);
        if (agentInfo && agentInfo.bsmSocket && agentInfo.bsmSocket.readyState === WebSocket.OPEN) {
            const message: WebSocketMessage = {
                type: 'squadLeader::agentCommand',
                payload: cmd,
                senderId: SQUAD_ID
            };
            agentInfo.bsmSocket.send(JSON.stringify(message));
        } else {
            console.warn(`Cannot send command to agent ${cmd.agentId}: BSM connection not available or agent not assigned.`);
            // TODO: Handle failure - report back? Retry?
        }
    });
}

// --- Reporting to Orchestrator ---
function sendToOrchestrator(message: WebSocketMessage) {
    if (orchestratorSocket && orchestratorSocket.readyState === WebSocket.OPEN) {
        message.senderId = SQUAD_ID; // Ensure senderId is set
        orchestratorSocket.send(JSON.stringify(message));
    } else {
        console.error(`Cannot send message to Orchestrator: WebSocket not connected.`);
        // TODO: Handle failure - queue message? Terminate?
    }
}

function reportStatusToOrchestrator(status: string, progress: number, details?: object) {
    console.log(`Reporting status to Orchestrator: ${status} (${progress * 100}%)`);
    sendToOrchestrator({
        type: 'squadLeader::statusUpdate',
        payload: { squadId: SQUAD_ID, status, progress, details }
    });
}

function reportStrategicFindToOrchestrator(findingDetails: object) {
     console.log(`Reporting strategic find to Orchestrator:`, findingDetails);
     sendToOrchestrator({
        type: 'squadLeader::reportStrategicFind',
        payload: { squadId: SQUAD_ID, findingDetails }
    });
}

function declareMissionComplete(results: object) {
    console.log(`Declaring mission complete to Orchestrator.`);
     sendToOrchestrator({
        type: 'squadLeader::missionComplete',
        payload: { squadId: SQUAD_ID, results }
    });
     // TODO: Should this trigger shutdown? Wait for terminate message?
}

function declareMissionFailed(reason: string) {
     console.log(`Declaring mission failed to Orchestrator: ${reason}`);
     sendToOrchestrator({
        type: 'squadLeader::missionFailed',
        payload: { squadId: SQUAD_ID, reason }
    });
     // TODO: Should this trigger shutdown? Wait for terminate message?
}


// --- WebSocket Connection to Orchestrator ---
function connectToOrchestrator() {
    console.log(`Connecting to Orchestrator at ${ORCHESTRATOR_ADDRESS}...`);
    // Add explicit check here to satisfy TS even though checked at top level
    if (!ORCHESTRATOR_ADDRESS) {
        console.error("Orchestrator address is unexpectedly undefined during connection attempt.");
        shutdown(1);
        return; // Should not be reachable due to shutdown, but good practice
    }
    orchestratorSocket = new WebSocket(ORCHESTRATOR_ADDRESS);

    orchestratorSocket.on('open', () => {
        console.log('Connected to Orchestrator.');
        // Register with Orchestrator
        const registrationMessage: WebSocketMessage = {
            type: 'squadLeader::register',
            senderId: SQUAD_ID,
            payload: {} // Add any relevant info if needed
        };
        orchestratorSocket?.send(JSON.stringify(registrationMessage));
    });

    orchestratorSocket.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            console.log(`Received message from Orchestrator: ${parsedMessage.type}`);

            if (parsedMessage.type === 'squadLeader::init' && !isInitialized) {
                handleInitialization(parsedMessage.payload);
            } else if (parsedMessage.type === 'squadLeader::terminate') {
                console.log('Received terminate signal from Orchestrator.');
                shutdown();
            }
            // Handle other messages from Orchestrator if needed
        } catch (error) {
            console.error('Failed to parse Orchestrator message or handle:', error);
        }
    });

    orchestratorSocket.on('close', () => {
        console.error('Disconnected from Orchestrator. Terminating.');
        orchestratorSocket = null;
        shutdown(1); // Exit with error code if disconnected unexpectedly
    });

    orchestratorSocket.on('error', (error: Error) => {
        console.error('Orchestrator WebSocket error:', error);
        orchestratorSocket = null;
        shutdown(1); // Exit with error code on connection error
    });
}

// --- WebSocket Connections to BSMs ---
function connectToBSMs(agentsToConnect: { agentId: string; bsmAddress: string }[]) {
    console.log('Connecting to BSMs for assigned agents...');
    agentsToConnect.forEach(agentInfo => {
        const existingAgent = assignedAgents.get(agentInfo.agentId);
        if (!existingAgent || existingAgent.bsmSocket) {
             console.warn(`Agent ${agentInfo.agentId} already has a BSM connection or is not assigned.`);
             return;
        }

        console.log(`Connecting to BSM at ${agentInfo.bsmAddress} for agent ${agentInfo.agentId}`);
        const bsmWs = new WebSocket(agentInfo.bsmAddress);
        existingAgent.bsmSocket = bsmWs; // Store socket immediately

        bsmWs.on('open', () => {
            console.log(`Connected to BSM for agent ${agentInfo.agentId}`);
            // No explicit registration needed here, BSM identifies based on commands
        });

        bsmWs.on('message', (message: Buffer) => {
            try {
                const parsedMessage: WebSocketMessage<AgentEvent | AgentStatusSnapshot> = JSON.parse(message.toString());
                 console.log(`Received message from BSM (via Agent ${agentInfo.agentId}): ${parsedMessage.type}`);

                // --- State Management & Context Builder ---
                if (parsedMessage.type.startsWith('agent::event::')) {
                    const event = parsedMessage.payload as AgentEvent;
                    // Update agent status summary based on event
                    // Add event type to recentEvents array for context
                    updateAgentStatusSummary(event.agentId, { eventType: event.eventType }); // Pass event type for handling
                    // TODO: Add event to recent events list for LLM context
                    // TODO: Filter for strategically critical findings and report up
                    if (event.eventType === 'foundPOI' && isStrategicFinding(event.details)) {
                         reportStrategicFindToOrchestrator(event.details);
                    }
                    // Trigger tactical planning based on significant agent events
                    if (isSignificantAgentEvent(event.eventType)) {
                        runTacticalPlanning({ type: 'agentEvent', event });
                    }
                } else if (parsedMessage.type === 'agent::statusUpdate') {
                     const snapshot = parsedMessage.payload as AgentStatusSnapshot;
                     // Update agent status summary directly
                     updateAgentStatusSummary(snapshot.agentId, snapshot.status);
                     // Potentially trigger planning if status change is significant
                     // runTacticalPlanning({ type: 'agentStatusUpdate', snapshot });
                }

            } catch (error) {
                console.error(`Failed to parse BSM message for agent ${agentInfo.agentId}:`, error);
            }
        });

        bsmWs.on('close', () => {
            console.warn(`Disconnected from BSM for agent ${agentInfo.agentId}`);
            if (existingAgent) {
                existingAgent.bsmSocket = null;
            }
            // TODO: Handle BSM disconnect - attempt reconnect? Report failure?
        });

        bsmWs.on('error', (error: Error) => {
            console.error(`BSM WebSocket error for agent ${agentInfo.agentId}:`, error);
             if (existingAgent) {
                existingAgent.bsmSocket = null;
            }
             // TODO: Handle BSM connection error
        });
    });
}

// --- Initialization Handler ---
function handleInitialization(payload: any) {
    console.log('Received initialization payload:', payload);
    missionDescription = payload.missionDescription;
    taskDetails = payload.taskDetails;
    const agentsToAssign: { agentId: string; bsmAddress: string }[] = payload.assignedAgents || [];

    agentsToAssign.forEach(a => {
        // Initialize basic summary including recentEvents array
        assignedAgents.set(a.agentId, {
            ...a,
            bsmSocket: null,
            statusSummary: {
                position: {x:0,y:0,z:0},
                health: 20,
                hunger: 20,
                recentEvents: [] // Initialize recentEvents
            }
        });
    });

    isInitialized = true;
    console.log(`Squad ${SQUAD_ID} initialized for mission: ${missionDescription}`);
    reportStatusToOrchestrator("Initialized", 0.1);

    // Connect to BSMs for the assigned agents
    connectToBSMs(agentsToAssign);

    // Trigger initial tactical planning
    runTacticalPlanning({ type: 'initialization' });
}

// --- Helper Functions ---
// Update function to handle adding to recentEvents
function updateAgentStatusSummary(agentId: string, updates: Partial<AgentStatusSnapshot['status']> & { eventType?: AgentEvent['eventType'] }) {
    const agentInfo = assignedAgents.get(agentId);
    if (agentInfo) {
        // Deep merge might be better if status objects become complex
        // Separate eventType from other status updates
        const { eventType, ...statusUpdates } = updates;
        Object.assign(agentInfo.statusSummary, statusUpdates);

        // Add event type to recentEvents, keeping the list short
        if (eventType) {
            if (!agentInfo.statusSummary.recentEvents) {
                agentInfo.statusSummary.recentEvents = [];
            }
            agentInfo.statusSummary.recentEvents.push(`${new Date().toLocaleTimeString()} - ${eventType}`);
            // Limit the size of recentEvents for LLM context
            if (agentInfo.statusSummary.recentEvents.length > 5) {
                agentInfo.statusSummary.recentEvents.shift(); // Remove oldest event
            }
        }
        // console.log(`Updated status summary for ${agentId}:`, agentInfo.statusSummary);
    }
}

function isStrategicFinding(details: any): boolean {
    // Rule-based filtering for strategic POIs based on specification
    const strategicTypes = ["minecraft:end_portal_frame", "minecraft:spawner", "minecraft:village", "minecraft:nether_fortress"];
    return details && details.poiType && strategicTypes.includes(details.poiType);
}

function isSignificantAgentEvent(eventType: AgentEvent['eventType']): boolean {
    // Define which agent events should trigger immediate tactical re-evaluation
    const significantEvents: AgentEvent['eventType'][] = [
        'taskComplete',
        'taskFailed',
        'detectedThreat',
        'tookDamage',
        // Add others as needed
    ];
    return significantEvents.includes(eventType);
}


// --- Main Execution ---
connectToOrchestrator();

// --- Graceful Shutdown ---
let isShuttingDown = false;
function shutdown(exitCode = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Squad Leader ${SQUAD_ID} shutting down...`);

    // 1. Close BSM connections
    assignedAgents.forEach(agent => {
        agent.bsmSocket?.close();
    });

    // 2. Close Orchestrator connection
    orchestratorSocket?.close();

    // 3. Add any other cleanup

    console.log(`Squad Leader ${SQUAD_ID} shutdown complete.`);
    // Use a small delay to allow close events to propagate
    setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION:', error);
    shutdown(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
    shutdown(1);
});