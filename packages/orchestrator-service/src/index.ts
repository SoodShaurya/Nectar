import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { GoogleGenerativeAI, FunctionDeclarationSchemaType, Part, FunctionDeclaration, GenerateContentRequest, Content, ChatSession, FunctionDeclarationSchema } from '@google/generative-ai';
import { WebSocketMessage, AgentInfo, SquadInfo, Coordinates } from '@aetherius/shared-types';
import { fork, ChildProcess } from 'child_process';
import path from 'path';

// --- Configuration ---
const PORT = parseInt(process.env.ORCHESTRATOR_PORT || '5000', 10);
const WS_PORT = parseInt(process.env.ORCHESTRATOR_WS_PORT || '5001', 10);
const WORLD_STATE_API_ADDRESS = process.env.WORLD_STATE_API_ADDRESS || 'http://localhost:3000';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SQUAD_LEADER_SCRIPT_PATH = process.env.SQUAD_LEADER_SCRIPT_PATH || path.resolve(__dirname, '../../squad-leader/dist/index.js');

console.log(`--- Orchestrator Service ---`);
console.log(`HTTP Port (Placeholder): ${PORT}`);
console.log(`WebSocket Port: ${WS_PORT}`);
console.log(`World State API Address: ${WORLD_STATE_API_ADDRESS}`);
console.log(`Squad Leader Script Path: ${SQUAD_LEADER_SCRIPT_PATH}`);


// --- State ---
const knownBSMs: Map<string, { address: string; ws: WebSocket | null }> = new Map();
const knownAgents: Map<string, AgentInfo> = new Map();
const activeSquads: Map<string, {
    squadId: string;
    process: ChildProcess | null;
    ws: WebSocket | null;
    mission: string;
    taskDetails: object;
    agentIds: string[];
    status: string;
}> = new Map();
const connectedFrontendClients: Set<WebSocket> = new Set();

// --- Plan Representation Structure (Goal 4.1) ---
interface PlanObjective {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  dependsOn?: string[];
  assignedSquad?: string;
}
interface PlanPhase {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  objectives: PlanObjective[];
}
type PlanRepresentation = PlanPhase[];
let currentPlanRepresentation: PlanRepresentation | null = null;

let strategicChatSession: ChatSession | null = null;
let isStrategicPlanningActive = false;
const squadFailureCounts: Map<string, number> = new Map(); // Track squad failures (Task 3.1)
const SQUAD_FAILURE_THRESHOLD = 3; // Threshold for triggering re-plan due to repeated failures

// --- LLM Planner ---
if (!GEMINI_API_KEY) {
    console.warn("WARNING: GEMINI_API_KEY environment variable not set. LLM Planner will not function.");
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "DUMMY_KEY");
const plannerModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

// --- Define Tools for Gemini Pro ---
const orchestratorTools: FunctionDeclaration[] = [
    {
        name: "delegateTaskToSquad",
        description: "Creates a new squad or assigns agents to an existing one for a specific mission.",
        parameters: {
            type: FunctionDeclarationSchemaType.OBJECT,
            properties: {
                missionDescription: { type: FunctionDeclarationSchemaType.STRING, description: "High-level description of the mission objective.", properties: {} },
                taskDetails: { type: FunctionDeclarationSchemaType.OBJECT, description: "Specific details or parameters for the mission (e.g., target coordinates, resource type/quantity).", properties: {} },
                requiredAgents: { type: FunctionDeclarationSchemaType.NUMBER, description: "The number of agents required for this mission." },
                selectionCriteria: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    description: "Criteria for selecting agents (e.g., proximity to targetCoords, requiredTags, requiredInventory). Default is proximity.",
                    properties: {
                        criteriaType: { type: FunctionDeclarationSchemaType.STRING, description: "Type of criteria ('proximity', 'random', 'tags', 'inventory', etc.)", properties: {} },
                        targetCoords: {
                            type: FunctionDeclarationSchemaType.OBJECT, description: "Target coordinates for proximity check.",
                            properties: { x: {type: FunctionDeclarationSchemaType.NUMBER}, y: {type: FunctionDeclarationSchemaType.NUMBER}, z: {type: FunctionDeclarationSchemaType.NUMBER} }, required: ['x', 'y', 'z']
                        },
                        requiredTags: { type: FunctionDeclarationSchemaType.ARRAY, description: "List of tags agents must possess.", properties: {} }, // Added empty properties object
                        requiredInventory: { type: FunctionDeclarationSchemaType.OBJECT, description: "Minimum required items in agent inventory.", properties: {} }
                    }
                 },
                 suggestedRoles: {
                    type: FunctionDeclarationSchemaType.ARRAY,
                    description: "Optional suggested roles for agents.",
                    items: {
                        type: FunctionDeclarationSchemaType.STRING,
                        properties: {}
                    },
                    properties: {}
                }
            },
            required: ['missionDescription', 'taskDetails', 'requiredAgents', 'selectionCriteria']
        }
    },
    {
        name: "requestWorldStateQuery",
        description: "Requests specific information from the World State Service database.",
        parameters: {
            type: FunctionDeclarationSchemaType.OBJECT,
            properties: {
                query: { type: FunctionDeclarationSchemaType.OBJECT, description: "A MongoDB-style query object or parameters for a predefined query.", properties: {} }
            },
            required: ['query']
        }
    },
    {
        name: "setPlanRepresentation",
        description: "Updates the Orchestrator's internal representation of the current strategic plan.",
        parameters: {
            type: FunctionDeclarationSchemaType.OBJECT,
            properties: {
                plan: {
                    type: FunctionDeclarationSchemaType.ARRAY,
                    description: "An array of PlanPhase objects representing the strategic plan.",
                    items: {
                        type: FunctionDeclarationSchemaType.OBJECT,
                        properties: {
                            id: { type: FunctionDeclarationSchemaType.STRING },
                            description: { type: FunctionDeclarationSchemaType.STRING },
                            status: { type: FunctionDeclarationSchemaType.STRING, enum: ['pending', 'in_progress', 'complete', 'failed'] },
                            objectives: {
                                type: FunctionDeclarationSchemaType.ARRAY,
                                items: {
                                    type: FunctionDeclarationSchemaType.OBJECT,
                                    properties: {
                                        id: { type: FunctionDeclarationSchemaType.STRING },
                                        description: { type: FunctionDeclarationSchemaType.STRING },
                                        status: { type: FunctionDeclarationSchemaType.STRING, enum: ['pending', 'in_progress', 'complete', 'failed'] },
                                        dependsOn: { type: FunctionDeclarationSchemaType.ARRAY, items: { type: FunctionDeclarationSchemaType.STRING, properties: {} } }, // Added properties: {} based on TS error
                                        assignedSquad: { type: FunctionDeclarationSchemaType.STRING }
                                    },
                                    required: ['id', 'description', 'status']
                                }
                            }
                        },
                        required: ['id', 'description', 'status', 'objectives']
                    }
                }
            },
            required: ['plan']
        }
    }
];


// --- Strategic Planning Function (Refactored for Goal 1 & 4) ---
async function runStrategicPlanning(triggeringEvent?: any) {
    if (!GEMINI_API_KEY) {
        console.log("Strategic planning skipped: API key missing.");
        return;
    }
    if (isStrategicPlanningActive) {
        console.log("Strategic planning skipped: Previous run still active.");
        return;
    }
    isStrategicPlanningActive = true;
    console.log("Running strategic planning...");
    if (triggeringEvent) console.log("Triggering Event:", triggeringEvent);

    try {
        // --- Initialize Chat Session ---
        if (!strategicChatSession) {
            console.log("Initializing new strategic chat session...");
            strategicChatSession = plannerModel.startChat({
                history: [], // Start fresh
                tools: [{ functionDeclarations: orchestratorTools }],
            });
        }

        // --- Prepare Context ---
        const worldStateQueryResult = await queryWorldState({ queryType: 'generalSummary', limit: 20 });
        const worldStateSummary = worldStateQueryResult ? JSON.stringify(worldStateQueryResult, null, 2) : "Could not fetch world state summary.";
        const availableAgents = Array.from(knownAgents.values()).filter(a => a.status === 'idle');
        const busyAgents = Array.from(knownAgents.values()).filter(a => a.status !== 'idle');
        const activeSquadSummaries = Array.from(activeSquads.values()).map(s => ({ squadId: s.squadId, mission: s.mission, status: s.status, agentIds: s.agentIds }));

        // --- Define System Instruction ---
        const systemInstructionText = `You are the Orchestrator AI for Aetherius, a Minecraft bot swarm. Your goal is to achieve the high-level objective: "Beat the Ender Dragon".
You manage the overall strategy by analyzing the current plan representation, world state, agent/squad status, and events.
Key Responsibilities:
- Maintain and update the strategic plan ('setPlanRepresentation'). The current plan is provided in the user prompt.
- Delegate tactical tasks to Squad Leaders ('delegateTaskToSquad') based on the plan's next steps.
- Request specific world state information ('requestWorldStateQuery') ONLY if essential data for planning is missing. Wait for the results before proceeding.
- Adapt the plan based on squad reports (completion/failure), strategic finds, and other significant events.
Base decisions *only* on provided context and conversation history. Prioritize the main goal. Be methodical.`;

        // --- Build User Prompt ---
        let userPromptParts: string[] = [];
        userPromptParts.push(`## Current Turn Context`);
        userPromptParts.push(`**High-Level Goal:** Beat the Ender Dragon.`);
        userPromptParts.push(`\n**Current Plan Representation:**`);
        userPromptParts.push(`\`\`\`json\n${JSON.stringify(currentPlanRepresentation || { status: 'No plan set yet' }, null, 2)}\n\`\`\``);
        userPromptParts.push(`\n**World State Summary:**`);
        userPromptParts.push(`\`\`\`json\n${worldStateSummary}\n\`\`\``);
        userPromptParts.push(`\n**Agent Status:**`);
        userPromptParts.push(`*   Available (${availableAgents.length}): ${availableAgents.map(a => a.agentId).join(', ') || 'None'}`);
        userPromptParts.push(`*   Busy (${busyAgents.length})`);
        userPromptParts.push(`\n**Active Squads:**`);
        userPromptParts.push(activeSquadSummaries.length > 0 ? `\`\`\`json\n${JSON.stringify(activeSquadSummaries, null, 2)}\n\`\`\`` : `*   None`);
        if (triggeringEvent) {
            userPromptParts.push(`\n**Triggering Event:**`);
            userPromptParts.push(`\`\`\`json\n${JSON.stringify(triggeringEvent, null, 2)}\n\`\`\``);
        }
        userPromptParts.push(`\n**Instruction:**`);
        userPromptParts.push(`Review the context. Update the plan ('setPlanRepresentation') if needed. If critical info is missing, query ('requestWorldStateQuery'). Otherwise, delegate the next task ('delegateTaskToSquad').`);
        const userPrompt = userPromptParts.join('\n');

        // --- LLM Interaction Loop ---
        console.log("--- Sending Initial Message to Gemini Pro ---");
        let llmResponse = await strategicChatSession.sendMessage(userPrompt);

        while (true) {
            const response = llmResponse.response;
            const functionCalls = response.functionCalls();

            if (functionCalls && functionCalls.length > 0) {
                console.log(`LLM Response: ${functionCalls.length} function call(s)`);
                const functionResponses: Part[] = [];

                for (const call of functionCalls) {
                    const { name, args } = call;
                    console.log(`Executing tool: ${name} with args:`, args);
                    let functionResultPayload: any = { success: false, error: "Unknown error during execution" };

                    try {
                        switch (name) {
                            case "delegateTaskToSquad": {
                                const typedArgs = args as { missionDescription: string; taskDetails: object; requiredAgents: number; selectionCriteria: object; suggestedRoles?: string[] };
                                if (typedArgs.missionDescription && typedArgs.taskDetails && typedArgs.requiredAgents && typedArgs.selectionCriteria) {
                                    createAndAssignSquad(typedArgs.missionDescription, typedArgs.taskDetails, typedArgs.requiredAgents, typedArgs.selectionCriteria);
                                    functionResultPayload = { success: true, status: "Squad spawning initiated" };
                                } else {
                                    console.error("Invalid arguments for delegateTaskToSquad:", args);
                                    functionResultPayload = { success: false, error: "Invalid arguments" };
                                }
                                break;
                            }
                            case "requestWorldStateQuery": {
                                const typedArgs = args as { query: object };
                                if (typedArgs.query) {
                                    const queryResult = await queryWorldState(typedArgs.query);
                                    console.log("World state query result obtained.");
                                    functionResultPayload = { success: true, result: queryResult ?? 'Query failed or returned null' };
                                } else {
                                    console.error("Invalid arguments for requestWorldStateQuery:", args);
                                    functionResultPayload = { success: false, error: "Invalid arguments" };
                                }
                                break;
                            }
                            case "setPlanRepresentation": {
                                const typedArgs = args as { plan: PlanRepresentation };
                                if (typedArgs.plan && Array.isArray(typedArgs.plan)) {
                                    console.log("Updating plan representation via LLM.");
                                    currentPlanRepresentation = typedArgs.plan as PlanRepresentation;
                                    functionResultPayload = { success: true, status: "Plan updated" };
                                } else {
                                    console.error("Invalid arguments for setPlanRepresentation: structure mismatch.", args);
                                    functionResultPayload = { success: false, error: "Invalid plan structure provided" };
                                }
                                break;
                            }
                            default:
                                console.warn(`Unknown function call requested by LLM: ${name}`);
                                functionResultPayload = { success: false, error: `Unknown function: ${name}` };
                        }
                    } catch (toolError) {
                        console.error(`Error executing tool ${name}:`, toolError);
                        functionResultPayload = { success: false, error: toolError instanceof Error ? toolError.message : String(toolError) };
                    }
                    functionResponses.push({ functionResponse: { name, response: functionResultPayload } });
                }

                console.log(`Sending ${functionResponses.length} function responses back to LLM...`);
                llmResponse = await strategicChatSession.sendMessage(functionResponses);

            } else {
                const responseText = response.text();
                if (responseText) {
                    console.log("LLM Response (final text):", responseText);
                } else {
                    console.log("LLM Response: No function calls or text content in final response.");
                }
                break; // Exit loop
            }
        }

    } catch (error) {
        console.error("Error during strategic planning LLM interaction:", error);
    } finally {
        isStrategicPlanningActive = false;
    }
}

// --- Squad Management (with Task 2.1 Implemented) ---
function selectAgents(count: number, criteria: any): AgentInfo[] {
     console.log(`Selecting ${count} agents with criteria:`, criteria);
     let candidateAgents = Array.from(knownAgents.values()).filter(a => a.status === 'idle');

     // Filter by Tags
     if (criteria?.requiredTags && Array.isArray(criteria.requiredTags) && criteria.requiredTags.length > 0) {
         candidateAgents = candidateAgents.filter(agent =>
             agent.tags && criteria.requiredTags.every((tag: string) => agent.tags!.includes(tag))
         );
         console.log(`Filtered agents by tags (${criteria.requiredTags.join(', ')}): ${candidateAgents.length} remaining.`);
     }

     // Filter by Inventory
     if (criteria?.requiredInventory && typeof criteria.requiredInventory === 'object') {
         candidateAgents = candidateAgents.filter(agent => {
             if (!agent.keyInventorySummary) return false;
             return Object.entries(criteria.requiredInventory).every(([item, requiredCount]) =>
                 (agent.keyInventorySummary![item] || 0) >= (requiredCount as number)
             );
         });
         console.log(`Filtered agents by inventory (${JSON.stringify(criteria.requiredInventory)}): ${candidateAgents.length} remaining.`);
     }

     // Check if enough agents remain
     if (candidateAgents.length < count) {
         console.warn(`Not enough idle agents (${candidateAgents.length}) matching criteria to fulfill request for ${count}.`);
         return [];
     }

     let selectedAgents: AgentInfo[] = [];

     // Apply sorting/selection strategy
     if (criteria?.criteriaType === 'proximity' && criteria?.targetCoords) {
         const target = criteria.targetCoords as Coordinates;
         candidateAgents.sort((a, b) => {
             const distA = a.lastKnownLocation ? distanceSquared(a.lastKnownLocation, target) : Infinity;
             const distB = b.lastKnownLocation ? distanceSquared(b.lastKnownLocation, target) : Infinity;
             if (distA === Infinity && distB === Infinity) return 0;
             if (distA === Infinity) return 1;
             if (distB === Infinity) return -1;
             return distA - distB;
         });
         selectedAgents = candidateAgents.slice(0, count);
         console.log(`Selected agents by proximity:`, selectedAgents.map(a => `${a.agentId} (Dist sq: ${a.lastKnownLocation ? distanceSquared(a.lastKnownLocation, target) : 'Unknown'})`));
     } else {
         // Default to Random Selection from candidates
         console.log("Using random agent selection from candidates.");
         const available = [...candidateAgents];
         for (let i = 0; i < count && available.length > 0; i++) {
             const randomIndex = Math.floor(Math.random() * available.length);
             selectedAgents.push(available.splice(randomIndex, 1)[0]);
         }
         console.log(`Selected agents randomly:`, selectedAgents.map(a => a.agentId));
     }

     return selectedAgents;
}

// Helper for distance calculation
function distanceSquared(pos1: Coordinates, pos2: Coordinates): number {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    const dz = pos1.z - pos2.z;
    return dx * dx + dy * dy + dz * dz;
}


function createAndAssignSquad(missionDescription: string, taskDetails: object, requiredAgents: number, selectionCriteria: object) {
    console.log(`Attempting to create squad for mission: ${missionDescription}`);
    const selectedAgents = selectAgents(requiredAgents, selectionCriteria);

    if (selectedAgents.length < requiredAgents) {
        console.error(`Failed to create squad: Only selected ${selectedAgents.length}/${requiredAgents} agents.`);
        // TODO: Handle failure
        return;
    }

    const squadId = `squad-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;
    console.log(`Spawning Squad Leader ${squadId}...`);

    try {
        const leaderPath = SQUAD_LEADER_SCRIPT_PATH;
        console.log(`Resolved Squad Leader Path for fork: ${leaderPath}`);

        const squadProcess = fork(leaderPath, [], {
            stdio: 'pipe',
            env: {
                ...process.env,
                SQUAD_ID: squadId,
                ORCHESTRATOR_ADDRESS: `ws://localhost:${WS_PORT}`,
                GEMINI_API_KEY: GEMINI_API_KEY
            }
        });

        squadProcess.stdout?.on('data', (data) => {
            console.log(`[Squad ${squadId} STDOUT]: ${data.toString().trim()}`);
        });
        squadProcess.stderr?.on('data', (data) => {
            console.error(`[Squad ${squadId} STDERR]: ${data.toString().trim()}`);
        });
         squadProcess.on('error', (err) => {
            console.error(`Squad ${squadId} process error:`, err);
            const squad = activeSquads.get(squadId);
            if (squad) {
                squad.agentIds.forEach(agentId => {
                    const agent = knownAgents.get(agentId);
                    if (agent) { agent.status = 'idle'; agent.currentSquadId = undefined; }
                });
                activeSquads.delete(squadId);
            }
             runStrategicPlanning({ type: 'squadSpawnError', squadId, error: err.message });
        });
        squadProcess.on('exit', (code, signal) => {
             console.log(`Squad ${squadId} process exited with code ${code}, signal ${signal}`);
             const squad = activeSquads.get(squadId);
             if (squad) {
                 squad.agentIds.forEach(agentId => {
                     const agent = knownAgents.get(agentId);
                     if (agent && agent.currentSquadId === squadId) {
                         agent.status = 'idle';
                         agent.currentSquadId = undefined;
                     }
                 });
                 activeSquads.delete(squadId);
                 console.log(`Cleaned up state for squad ${squadId}.`);
                 if (code !== 0) {
                     runStrategicPlanning({ type: 'squadUnexpectedExit', squadId, code, signal });
                 }
             }
        });

        activeSquads.set(squadId, {
            squadId,
            process: squadProcess,
            ws: null,
            mission: missionDescription,
            taskDetails: taskDetails,
            agentIds: selectedAgents.map(a => a.agentId),
            status: "Spawning"
        });

        selectedAgents.forEach(agent => {
            const agentInfo = knownAgents.get(agent.agentId);
            if (agentInfo) {
                agentInfo.status = 'busy';
                agentInfo.currentSquadId = squadId;
            }
        });

        console.log(`Squad ${squadId} spawned (PID: ${squadProcess.pid}) and agents assigned.`);

    } catch (error) {
        console.error(`Error spawning squad leader process for ${squadId}:`, error);
         selectedAgents.forEach(agent => {
             const agentInfo = knownAgents.get(agent.agentId);
             if (agentInfo) { agentInfo.status = 'idle'; agentInfo.currentSquadId = undefined; }
        });
         runStrategicPlanning({ type: 'squadSpawnException', error });
    }
}

function sendInitToSquadLeader(squadId: string, ws: WebSocket) {
     const squad = activeSquads.get(squadId);
     const agents = knownAgents;

     if (!squad) {
         console.error(`Cannot send init to Squad ${squadId}: Squad not found.`);
         ws.close(1011, "Squad ID not recognized");
         return;
     }
     if (squad.ws) {
         console.warn(`Squad ${squadId} already has a WebSocket connection. Ignoring new connection.`);
         return;
     }

     console.log(`Squad Leader ${squadId} connected via WebSocket. Sending init...`);
     squad.ws = ws;
     squad.status = "Initializing";

     const initPayload = {
         squadId: squad.squadId,
         missionDescription: squad.mission,
         taskDetails: squad.taskDetails,
         assignedAgents: squad.agentIds.map(agentId => {
             const agent = agents.get(agentId);
             if (agent && agent.bsmAddress) {
                 return { agentId: agentId, bsmAddress: agent.bsmAddress };
             }
             console.warn(`Agent ${agentId} or their BSM address not found for squad init.`);
             return null;
         }).filter(a => a !== null) as { agentId: string; bsmAddress: string }[]
     };

     if (initPayload.assignedAgents.length !== squad.agentIds.length) {
         console.error(`Error preparing init payload for Squad ${squadId}: Could not find BSM address for all assigned agents.`);
         terminateSquadLeader(squadId, "Failed to find BSM addresses for all agents");
         return;
     }

     const message: WebSocketMessage = {
         type: 'squadLeader::init',
         payload: initPayload,
         senderId: 'orchestrator'
     };
     ws.send(JSON.stringify(message));
     console.log(`Sent init to Squad ${squadId}`);
}

function terminateSquadLeader(squadId: string, reason: string = "Mission ended") {
    const squad = activeSquads.get(squadId);
    if (!squad) {
        console.warn(`Cannot terminate Squad ${squadId}: Not found.`);
        return;
    }
    console.log(`Terminating Squad Leader ${squadId}. Reason: ${reason}`);

    if (squad.ws && squad.ws.readyState === WebSocket.OPEN) {
        try {
            const message: WebSocketMessage = { type: 'squadLeader::terminate', payload: { reason }, senderId: 'orchestrator' };
            squad.ws.send(JSON.stringify(message));
            squad.ws.close(1000, "Termination requested by Orchestrator");
        } catch (err) {
            console.error(`Error sending terminate message to Squad ${squadId}:`, err);
        }
    } else {
         console.warn(`Squad ${squadId} WS connection not open or available for sending terminate message.`);
    }

    if (squad.process && !squad.process.killed) {
        console.log(`Sending SIGTERM to Squad Leader process ${squad.process.pid}`);
        const killed = squad.process.kill('SIGTERM');
        if (!killed) {
             console.warn(`Failed to send SIGTERM to Squad Leader ${squadId} process ${squad.process.pid}.`);
        }
        setTimeout(() => {
            if (squad.process && !squad.process.killed) {
                console.warn(`Squad Leader ${squadId} did not terminate gracefully, sending SIGKILL.`);
                squad.process.kill('SIGKILL');
            }
        }, 5000);
    }

    squad.agentIds.forEach(agentId => {
        const agent = knownAgents.get(agentId);
         if (agent && agent.currentSquadId === squadId) {
            agent.status = 'idle';
            agent.currentSquadId = undefined;
        }
    });
    activeSquads.delete(squadId);
    console.log(`Termination process initiated for Squad ${squadId}. State cleaned.`);
}


// --- World State Interface ---
async function queryWorldState(query: object): Promise<any> {
    console.log(`Querying World State Service:`, query);
    try {
        const params = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => {
            params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        });

        const response = await fetch(`${WORLD_STATE_API_ADDRESS}/query?${params.toString()}`);
        if (!response.ok) {
            console.error(`Error querying World State: ${response.status} ${response.statusText}`);
            return null;
        }
        const results = await response.json();
        console.log(`World State query returned ${results?.length ?? 0} results.`);
        return results;
    } catch (error) {
        console.error('Fetch error querying World State:', error);
        return null;
    }
}


// --- WebSocket Server ---
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`Orchestrator WebSocket server listening on port ${WS_PORT}`);

wss.on('connection', (ws: WebSocket) => {
    console.log('WS Client connected to Orchestrator');

    ws.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            console.log(`Orchestrator received WS message type: ${parsedMessage.type} from ${parsedMessage.senderId}`);

            // --- Handle BSM Registration ---
            if (parsedMessage.type === 'bsm::register') {
                const { bsmId, address, capacity, agents } = parsedMessage.payload;
                if (bsmId && address && agents && Array.isArray(agents)) {
                    console.log(`BSM Registered: ${bsmId} at ${address} (Capacity: ${capacity || 'N/A'})`);
                    knownBSMs.set(bsmId, { address, ws });
                    agents.forEach((agentData: { agentId: string, status?: string }) => {
                        if (!knownAgents.has(agentData.agentId)) {
                             console.log(`Registering new agent ${agentData.agentId} from BSM ${bsmId}`);
                             knownAgents.set(agentData.agentId, {
                                 agentId: agentData.agentId,
                                 bsmAddress: address,
                                 status: 'idle',
                                 currentSquadId: undefined,
                                 lastKnownLocation: undefined
                             });
                        } else {
                             console.log(`Agent ${agentData.agentId} already known.`);
                             const agent = knownAgents.get(agentData.agentId);
                             if (agent) agent.bsmAddress = address;
                        }
                    });
                } else {
                     console.error('Invalid bsm::register message payload:', parsedMessage.payload);
                }
            }
            // --- Handle Squad Leader Registration ---
            else if (parsedMessage.type === 'squadLeader::register') {
                 const squadId = parsedMessage.senderId;
                 if (squadId && activeSquads.has(squadId)) {
                     sendInitToSquadLeader(squadId, ws);
                 } else {
                     console.error(`Received registration from unknown or inactive Squad ID: ${squadId}`);
                     ws.close(1008, "Unknown Squad ID");
                 }
            }
            // --- Handle Squad Leader Reports ---
            else if (parsedMessage.type === 'squadLeader::statusUpdate') {
                const { squadId, status, progress, details } = parsedMessage.payload;
                const squad = activeSquads.get(squadId);
                if (squad) {
                    console.log(`Status update from Squad ${squadId}: ${status} (${(progress * 100).toFixed(1)}%)`);
                    squad.status = status;
                } else {
                     console.warn(`Received status update for unknown squad: ${squadId}`);
                }
            } else if (parsedMessage.type === 'squadLeader::missionComplete') {
                 const { squadId, results } = parsedMessage.payload;
                 console.log(`Mission complete for Squad ${squadId}:`, results);
                 terminateSquadLeader(squadId, "Mission Complete");
                 runStrategicPlanning({ type: 'missionComplete', squadId, results });
            } else if (parsedMessage.type === 'squadLeader::missionFailed') {
                 const { squadId, reason } = parsedMessage.payload;
                 console.log(`Mission failed for Squad ${squadId}: ${reason}`);
                 terminateSquadLeader(squadId, `Mission Failed: ${reason}`);

                 // --- Nuanced Event Detection (Task 3.1) ---
                 const currentFailures = (squadFailureCounts.get(squadId) || 0) + 1;
                 squadFailureCounts.set(squadId, currentFailures);
                 console.log(`Squad ${squadId} failure count: ${currentFailures}`);

                 const failureEvent: any = { type: 'missionFailed', squadId, reason };
                 if (currentFailures >= SQUAD_FAILURE_THRESHOLD) {
                     console.warn(`Squad ${squadId} has failed ${currentFailures} times (>= threshold ${SQUAD_FAILURE_THRESHOLD}). Triggering specific re-plan.`);
                     failureEvent.type = 'repeatedSquadFailure'; // Modify event type
                     // Optionally reset count after triggering special re-plan
                     // squadFailureCounts.delete(squadId);
                 }
                 runStrategicPlanning(failureEvent);
                 // --- End Task 3.1 ---

            } else if (parsedMessage.type === 'squadLeader::reportStrategicFind') {
                 const { squadId, findingDetails } = parsedMessage.payload;
                 console.log(`Strategic find reported by Squad ${squadId}:`, findingDetails);
                 runStrategicPlanning({ type: 'strategicFind', squadId, findingDetails });
            }
             // --- Handle Agent Lost ---
             else if (parsedMessage.type === 'squadLeader::agentLost') {
                 const { squadId, agentId, reason } = parsedMessage.payload;
                 console.warn(`Agent ${agentId} lost from Squad ${squadId}. Reason: ${reason}`);
                 const agent = knownAgents.get(agentId);
                 if (agent) {
                     agent.status = 'unknown';
                     agent.currentSquadId = undefined;
                 }
                 runStrategicPlanning({ type: 'agentLost', agentId, squadId, reason });
             }
            // --- Handle Frontend Registration/Commands ---
            else if (parsedMessage.type === 'frontend::register') {
                console.log('Frontend client registered.');
                connectedFrontendClients.add(ws);
            } else if (parsedMessage.type === 'frontend::startGoal') {
                 const { goal } = parsedMessage.payload;
                 console.log(`Received start goal from frontend: ${goal}`);
                 runStrategicPlanning({ type: 'startGoal', goal });
            }

        } catch (error) {
            console.error('Failed to parse Orchestrator WS message or handle:', error);
        }
    });

    ws.on('close', () => {
        console.log('WS Client disconnected from Orchestrator');
        connectedFrontendClients.delete(ws);
        let disconnectedId: string | null = null;
        let disconnectedType: 'bsm' | 'squad' | null = null;

        for (const [id, bsm] of knownBSMs.entries()) {
            if (bsm.ws === ws) {
                disconnectedId = id;
                disconnectedType = 'bsm';
                break;
            }
        }
        if (disconnectedId && disconnectedType === 'bsm') {
             console.log(`BSM ${disconnectedId} disconnected.`);
             const bsmAddress = knownBSMs.get(disconnectedId)?.address; // Get address before deleting
             knownBSMs.delete(disconnectedId);
             // Mark agents associated with this BSM as unknown
             knownAgents.forEach(agent => {
                 if (agent.bsmAddress === bsmAddress) {
                     agent.status = 'unknown';
                     console.log(`Marked agent ${agent.agentId} as unknown due to BSM disconnect.`);
                 }
             });
        } else {
             for (const [id, squad] of activeSquads.entries()) {
                 if (squad.ws === ws) {
                     disconnectedId = id;
                     disconnectedType = 'squad';
                     console.warn(`Squad Leader ${id} disconnected unexpectedly.`);
                     squad.ws = null;
                     break;
                 }
             }
        }
    });

    ws.on('error', (error: Error) => {
        console.error('Orchestrator WebSocket error:', error);
         connectedFrontendClients.delete(ws);
         let disconnectedId: string | null = null;
         for (const [id, bsm] of knownBSMs.entries()) {
             if (bsm.ws === ws) { disconnectedId = id; break; }
         }
          if (disconnectedId) knownBSMs.delete(disconnectedId);
          for (const [id, squad] of activeSquads.entries()) {
             if (squad.ws === ws) { squad.ws = null; break; }
         }
    });
});

// --- Placeholder HTTP Server ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Orchestrator Running', knownBSMs: knownBSMs.size, knownAgents: knownAgents.size, activeSquads: activeSquads.size }));
});

server.listen(PORT, () => {
    console.log(`Orchestrator placeholder HTTP server listening on port ${PORT}`);
});


// --- Initial Startup ---
console.log("Orchestrator started. Waiting for connections...");


// --- Graceful Shutdown ---
function shutdown() {
    console.log('Shutting down Orchestrator...');
    wss.close(() => console.log('Orchestrator WebSocket server closed.'));
    server.close(() => console.log('Orchestrator HTTP server closed.'));
    console.log('Terminating active squad leaders...');
    activeSquads.forEach((squad, squadId) => {
        terminateSquadLeader(squadId, "Orchestrator shutting down");
    });
    console.log("Orchestrator shutdown complete.");
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
