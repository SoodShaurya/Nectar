import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
// import { GoogleGenerativeAI } from '@google/generative-ai'; // Uncomment when implementing LLM
import { WebSocketMessage, AgentInfo, SquadInfo } from '@aetherius/shared-types';

// --- Configuration ---
const PORT = process.env.ORCHESTRATOR_PORT || 5000;
const WS_PORT = parseInt(process.env.ORCHESTRATOR_WS_PORT || '5001', 10);
const WORLD_STATE_API_ADDRESS = process.env.WORLD_STATE_API_ADDRESS || 'http://localhost:3000';
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Uncomment when implementing LLM

console.log(`--- Orchestrator Service ---`);
console.log(`HTTP Port (Placeholder): ${PORT}`);
console.log(`WebSocket Port: ${WS_PORT}`);
console.log(`World State API Address: ${WORLD_STATE_API_ADDRESS}`);

// --- State ---
const knownBSMs: Map<string, { address: string; ws: WebSocket | null }> = new Map(); // Key: bsmId
const knownAgents: Map<string, AgentInfo> = new Map(); // Key: agentId
const activeSquads: Map<string, SquadInfo> = new Map(); // Key: squadId
const connectedFrontendClients: Set<WebSocket> = new Set();
// TODO: Add state for Plan Representation

// --- LLM Planner (Placeholder) ---
// const genAI = new GoogleGenerativeAI(GEMINI_API_KEY!);
// const plannerModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" }); // Or specific version
async function runStrategicPlanning(triggeringEvent?: any) {
    console.log("Running strategic planning (Placeholder)...", { triggeringEvent });
    // TODO: Build context (Goal, Plan Rep, World State Summary, Agents, Squads, Event)
    // TODO: Interact with Gemini Pro using function calling (delegateTaskToSquad, requestWorldStateQuery, setPlanRepresentation)
    // TODO: Parse response and update state/trigger actions
}

// --- Squad Management (Placeholder) ---
function createAndAssignSquad(missionDescription: string, taskDetails: object, requiredAgents: number, selectionCriteria: object) {
    console.log(`Creating squad for mission: ${missionDescription}`);
    // TODO: Implement agent selection based on criteria (proximity, random, etc.)
    // TODO: Spawn Squad Leader process (requires path to squad-leader script)
    // TODO: Generate unique squadId
    // TODO: Connect to Squad Leader's WebSocket
    // TODO: Send squadLeader::init message
    // TODO: Update knownAgents and activeSquads state
}

// --- World State Interface (Placeholder) ---
async function queryWorldState(query: object): Promise<any> {
    console.log(`Querying World State Service (Placeholder):`, query);
    try {
        const response = await fetch(`${WORLD_STATE_API_ADDRESS}/query?${new URLSearchParams(query as any)}`);
        if (!response.ok) {
            console.error(`Error querying World State: ${response.status} ${response.statusText}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('Fetch error querying World State:', error);
        return null;
    }
}


// --- WebSocket Server (for BSMs, Squad Leaders, Frontend) ---
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`Orchestrator WebSocket server listening on port ${WS_PORT}`);

wss.on('connection', (ws: WebSocket) => {
    console.log('WS Client connected to Orchestrator');
    // Type needs to be determined via handshake/first message

    ws.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            console.log(`Orchestrator received WS message type: ${parsedMessage.type} from ${parsedMessage.senderId}`);

            // --- Handle BSM Registration ---
            if (parsedMessage.type === 'bsm::register') {
                const { bsmId, address, capacity } = parsedMessage.payload; // Assuming payload structure
                if (bsmId && address) {
                    console.log(`BSM Registered: ${bsmId} at ${address} (Capacity: ${capacity || 'N/A'})`);
                    knownBSMs.set(bsmId, { address, ws }); // Store WS connection for direct communication if needed
                    // TODO: Request agent list from BSM or assume initial agents based on capacity?
                    // Example: Send message back to BSM to request agent details
                    // ws.send(JSON.stringify({ type: 'orchestrator::requestAgentInfo' }));
                } else {
                     console.error('Invalid bsm::register message payload:', parsedMessage.payload);
                }
            }
            // --- Handle Squad Leader Reports ---
            else if (parsedMessage.type === 'squadLeader::statusUpdate') {
                const { squadId, status, progress, details } = parsedMessage.payload;
                console.log(`Status update from Squad ${squadId}: ${status} (${progress * 100}%)`);
                // TODO: Update activeSquads state
                // TODO: Potentially update Frontend clients
            } else if (parsedMessage.type === 'squadLeader::missionComplete') {
                 const { squadId, results } = parsedMessage.payload;
                 console.log(`Mission complete for Squad ${squadId}:`, results);
                 // TODO: Update activeSquads, mark agents as idle in knownAgents
                 // TODO: Terminate Squad Leader process (send squadLeader::terminate)
                 // TODO: Trigger strategic re-evaluation (Significant Event)
                 runStrategicPlanning({ type: 'missionComplete', squadId, results });
            } else if (parsedMessage.type === 'squadLeader::missionFailed') {
                 const { squadId, reason } = parsedMessage.payload;
                 console.log(`Mission failed for Squad ${squadId}: ${reason}`);
                 // TODO: Update activeSquads, mark agents as idle in knownAgents
                 // TODO: Terminate Squad Leader process
                 // TODO: Trigger strategic re-evaluation (Significant Event)
                 runStrategicPlanning({ type: 'missionFailed', squadId, reason });
            } else if (parsedMessage.type === 'squadLeader::reportStrategicFind') {
                 const { squadId, findingDetails } = parsedMessage.payload;
                 console.log(`Strategic find reported by Squad ${squadId}:`, findingDetails);
                 // TODO: Trigger strategic re-evaluation (Significant Event)
                 runStrategicPlanning({ type: 'strategicFind', squadId, findingDetails });
            }
            // --- Handle Frontend Registration/Commands ---
            else if (parsedMessage.type === 'frontend::register') {
                console.log('Frontend client registered.');
                connectedFrontendClients.add(ws);
                // Send initial state?
            } else if (parsedMessage.type === 'frontend::startGoal') {
                 const { goal } = parsedMessage.payload;
                 console.log(`Received start goal from frontend: ${goal}`);
                 // TODO: Initiate the main planning process
                 runStrategicPlanning({ type: 'startGoal', goal });
            }
            // Add other message handlers as needed

        } catch (error) {
            console.error('Failed to parse Orchestrator WS message or handle:', error);
        }
    });

    ws.on('close', () => {
        console.log('WS Client disconnected from Orchestrator');
        // Remove from knownBSMs, connectedFrontendClients etc. if applicable
        connectedFrontendClients.delete(ws);
        for (const [id, bsm] of knownBSMs.entries()) {
            if (bsm.ws === ws) {
                console.log(`BSM ${id} disconnected.`);
                knownBSMs.delete(id); // Or just mark ws as null?
                break;
            }
        }
        // TODO: Handle Squad Leader disconnects
    });

    ws.on('error', (error: Error) => {
        console.error('Orchestrator WebSocket error:', error);
         // Clean up connection state
         connectedFrontendClients.delete(ws);
         for (const [id, bsm] of knownBSMs.entries()) {
             if (bsm.ws === ws) {
                 knownBSMs.delete(id);
                 break;
             }
         }
    });
});

// --- Placeholder HTTP Server (Optional - for status checks?) ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Orchestrator Running', knownBSMs: knownBSMs.size, knownAgents: knownAgents.size, activeSquads: activeSquads.size }));
});

server.listen(PORT, () => {
    console.log(`Orchestrator placeholder HTTP server listening on port ${PORT}`);
});


// --- Initial Startup ---
console.log("Orchestrator started. Waiting for connections...");
// TODO: Potentially load initial state or start initial planning


// --- Graceful Shutdown ---
function shutdown() {
    console.log('Shutting down Orchestrator...');
    wss.close(() => console.log('Orchestrator WebSocket server closed.'));
    server.close(() => console.log('Orchestrator HTTP server closed.'));
    // TODO: Send termination signals to active Squad Leaders?
    // TODO: Disconnect from BSMs?
    console.log("Orchestrator shutdown complete.");
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);