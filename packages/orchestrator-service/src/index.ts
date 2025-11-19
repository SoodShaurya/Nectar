import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { GoogleGenerativeAI, FunctionDeclarationSchemaType, Part, FunctionDeclaration, GenerateContentRequest, Content, ChatSession, FunctionDeclarationSchema } from '@google/generative-ai';
import {
  WebSocketMessage,
  AgentInfo,
  SquadInfo,
  Coordinates,
  createLogger,
  validateConfig,
  orchestratorConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  HealthChecks,
  metrics,
  CircuitBreaker,
  LLMCache,
  RateLimiter,
  retryWithBackoff
} from '@aetherius/shared-types';
import { fork, ChildProcess } from 'child_process';
import path from 'path';

// --- Initialize Logger ---
const logger = createLogger('orchestrator-service');

// --- Validate Configuration ---
const config = validateConfig(orchestratorConfigSchema, 'Orchestrator Service');

logger.info('Starting Orchestrator Service', {
  httpPort: config.ORCHESTRATOR_PORT,
  wsPort: config.ORCHESTRATOR_WS_PORT,
  worldStateApi: config.WORLD_STATE_API_ADDRESS,
  squadLeaderPath: config.SQUAD_LEADER_SCRIPT_PATH || path.resolve(__dirname, '../../squad-leader/dist/index.js')
});

const PORT = config.ORCHESTRATOR_PORT;
const WS_PORT = config.ORCHESTRATOR_WS_PORT;
const WORLD_STATE_API_ADDRESS = config.WORLD_STATE_API_ADDRESS;
const GEMINI_API_KEY = config.GEMINI_API_KEY;
const SQUAD_LEADER_SCRIPT_PATH = config.SQUAD_LEADER_SCRIPT_PATH || path.resolve(__dirname, '../../squad-leader/dist/index.js');

// --- Initialize Resilience Patterns ---
// Circuit breaker for Gemini API calls (prevents cascading failures)
const geminiCircuitBreaker = new CircuitBreaker('gemini-api', {
  failureThreshold: 5,
  resetTimeout: 60000,
  onStateChange: (state) => logger.warn('Gemini API circuit breaker state changed', { state })
});

// LLM cache for strategic planning responses (reduces API costs)
const llmCache = new LLMCache({ ttl: 5 * 60 * 1000 }); // 5 minute TTL

// Rate limiter for Gemini Pro (60 calls/minute)
const geminiRateLimiter = new RateLimiter({
  maxCalls: 60,
  windowMs: 60000
});

logger.info('Resilience patterns initialized', {
  circuitBreaker: 'gemini-api',
  llmCacheTTL: '5 minutes',
  rateLimit: '60 calls/minute'
});

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
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const plannerModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

logger.info('Gemini AI planner initialized', { model: 'gemini-1.5-pro-latest' });

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
    if (isStrategicPlanningActive) {
        logger.debug('Strategic planning skipped: Previous run still active');
        return;
    }
    isStrategicPlanningActive = true;
    const planningStartTime = Date.now();

    logger.info('Starting strategic planning cycle', {
      triggeringEvent: triggeringEvent ? triggeringEvent.type : 'initial'
    });
    if (triggeringEvent) {
        logger.debug('Planning triggered by event', { event: triggeringEvent });
    }

    metrics.increment('strategic_planning_cycles');

    try {
        // --- Initialize Chat Session ---
        if (!strategicChatSession) {
            logger.info('Initializing new strategic chat session');
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

        // --- LLM Interaction Loop with Resilience Patterns ---
        logger.debug('Preparing to call Gemini Pro for strategic planning');

        // Check cache first
        const cacheKey = llmCache.getCacheKey(userPrompt, {
          worldState: worldStateSummary,
          availableAgents: availableAgents.length,
          activeSquads: activeSquadSummaries.length
        });

        let llmResponse: any;
        const cachedResponse = llmCache.get(cacheKey);

        if (cachedResponse) {
            logger.info('Using cached LLM response for strategic planning');
            metrics.increment('llm_cache_hits');
            llmResponse = cachedResponse;
        } else {
            logger.info('Calling Gemini Pro API for strategic planning');
            metrics.increment('llm_cache_misses');

            // Apply rate limiting
            await geminiRateLimiter.waitIfNeeded();

            // Execute through circuit breaker with metrics
            llmResponse = await metrics.measureAsync('llm_strategic_call', async () => {
                return await geminiCircuitBreaker.execute(async () => {
                    return await strategicChatSession!.sendMessage(userPrompt);
                });
            });

            // Cache the response
            llmCache.set(cacheKey, llmResponse);
            logger.debug('LLM response cached successfully');
        }

        while (true) {
            const response = llmResponse.response;
            const functionCalls = response.functionCalls();

            if (functionCalls && functionCalls.length > 0) {
                logger.info('LLM requested function calls', { count: functionCalls.length });
                metrics.increment('llm_function_calls', functionCalls.length);
                const functionResponses: Part[] = [];

                for (const call of functionCalls) {
                    const { name, args } = call;
                    logger.debug('Executing LLM tool', { tool: name, args });
                    let functionResultPayload: any = { success: false, error: "Unknown error during execution" };

                    try {
                        switch (name) {
                            case "delegateTaskToSquad": {
                                const typedArgs = args as { missionDescription: string; taskDetails: object; requiredAgents: number; selectionCriteria: object; suggestedRoles?: string[] };
                                if (typedArgs.missionDescription && typedArgs.taskDetails && typedArgs.requiredAgents && typedArgs.selectionCriteria) {
                                    createAndAssignSquad(typedArgs.missionDescription, typedArgs.taskDetails, typedArgs.requiredAgents, typedArgs.selectionCriteria);
                                    functionResultPayload = { success: true, status: "Squad spawning initiated" };
                                    metrics.increment('squads_delegated');
                                } else {
                                    logger.error('Invalid arguments for delegateTaskToSquad', { args });
                                    functionResultPayload = { success: false, error: "Invalid arguments" };
                                }
                                break;
                            }
                            case "requestWorldStateQuery": {
                                const typedArgs = args as { query: object };
                                if (typedArgs.query) {
                                    const queryResult = await queryWorldState(typedArgs.query);
                                    logger.debug('World state query completed', { resultCount: queryResult?.length ?? 0 });
                                    functionResultPayload = { success: true, result: queryResult ?? 'Query failed or returned null' };
                                    metrics.increment('world_state_queries');
                                } else {
                                    logger.error('Invalid arguments for requestWorldStateQuery', { args });
                                    functionResultPayload = { success: false, error: "Invalid arguments" };
                                }
                                break;
                            }
                            case "setPlanRepresentation": {
                                const typedArgs = args as { plan: PlanRepresentation };
                                if (typedArgs.plan && Array.isArray(typedArgs.plan)) {
                                    logger.info('Updating plan representation via LLM', { phases: typedArgs.plan.length });
                                    currentPlanRepresentation = typedArgs.plan as PlanRepresentation;
                                    functionResultPayload = { success: true, status: "Plan updated" };
                                    metrics.increment('plan_updates');
                                } else {
                                    logger.error('Invalid arguments for setPlanRepresentation: structure mismatch', { args });
                                    functionResultPayload = { success: false, error: "Invalid plan structure provided" };
                                }
                                break;
                            }
                            default:
                                logger.warn('Unknown function call requested by LLM', { functionName: name });
                                functionResultPayload = { success: false, error: `Unknown function: ${name}` };
                        }
                    } catch (toolError) {
                        logger.error('Error executing LLM tool', { tool: name, error: toolError });
                        metrics.increment('tool_execution_errors');
                        functionResultPayload = { success: false, error: toolError instanceof Error ? toolError.message : String(toolError) };
                    }
                    functionResponses.push({ functionResponse: { name, response: functionResultPayload } });
                }

                logger.debug('Sending function responses back to LLM', { count: functionResponses.length });
                llmResponse = await strategicChatSession.sendMessage(functionResponses);

            } else {
                const responseText = response.text();
                if (responseText) {
                    logger.info('LLM completed planning with final text', { length: responseText.length });
                } else {
                    logger.debug('LLM response: No function calls or text content in final response');
                }
                break; // Exit loop
            }
        }

        const planningDuration = Date.now() - planningStartTime;
        metrics.record('strategic_planning_duration', planningDuration);
        logger.info('Strategic planning cycle completed', { durationMs: planningDuration });

    } catch (error) {
        logger.error('Error during strategic planning LLM interaction', { error });
        metrics.increment('strategic_planning_errors');
    } finally {
        isStrategicPlanningActive = false;
    }
}

// --- Squad Management (with Task 2.1 Implemented) ---
function selectAgents(count: number, criteria: any): AgentInfo[] {
     logger.debug('Selecting agents for squad', { count, criteria });
     let candidateAgents = Array.from(knownAgents.values()).filter(a => a.status === 'idle');

     // Filter by Tags
     if (criteria?.requiredTags && Array.isArray(criteria.requiredTags) && criteria.requiredTags.length > 0) {
         candidateAgents = candidateAgents.filter(agent =>
             agent.tags && criteria.requiredTags.every((tag: string) => agent.tags!.includes(tag))
         );
         logger.debug('Filtered agents by tags', {
           tags: criteria.requiredTags.join(', '),
           remaining: candidateAgents.length
         });
     }

     // Filter by Inventory
     if (criteria?.requiredInventory && typeof criteria.requiredInventory === 'object') {
         candidateAgents = candidateAgents.filter(agent => {
             if (!agent.keyInventorySummary) return false;
             return Object.entries(criteria.requiredInventory).every(([item, requiredCount]) =>
                 (agent.keyInventorySummary![item] || 0) >= (requiredCount as number)
             );
         });
         logger.debug('Filtered agents by inventory', {
           requirements: criteria.requiredInventory,
           remaining: candidateAgents.length
         });
     }

     // Check if enough agents remain
     if (candidateAgents.length < count) {
         logger.warn('Not enough idle agents matching criteria', {
           available: candidateAgents.length,
           required: count
         });
         metrics.increment('agent_selection_failures');
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
         logger.info('Selected agents by proximity', {
           agentIds: selectedAgents.map(a => a.agentId),
           targetCoords: target
         });
     } else {
         // Default to Random Selection from candidates
         logger.debug('Using random agent selection from candidates');
         const available = [...candidateAgents];
         for (let i = 0; i < count && available.length > 0; i++) {
             const randomIndex = Math.floor(Math.random() * available.length);
             selectedAgents.push(available.splice(randomIndex, 1)[0]);
         }
         logger.info('Selected agents randomly', { agentIds: selectedAgents.map(a => a.agentId) });
     }

     metrics.increment('agents_selected', selectedAgents.length);
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
    logger.info('Attempting to create squad for mission', { mission: missionDescription, requiredAgents });
    const selectedAgents = selectAgents(requiredAgents, selectionCriteria);

    if (selectedAgents.length < requiredAgents) {
        logger.error('Failed to create squad: insufficient agents', {
          selected: selectedAgents.length,
          required: requiredAgents
        });
        metrics.increment('squad_creation_failures');
        return;
    }

    const squadId = `squad-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;
    logger.info('Spawning Squad Leader', { squadId, mission: missionDescription });

    try {
        const leaderPath = SQUAD_LEADER_SCRIPT_PATH;
        logger.debug('Resolved Squad Leader path for fork', { path: leaderPath });

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
            logger.debug('Squad stdout', { squadId, output: data.toString().trim() });
        });
        squadProcess.stderr?.on('data', (data) => {
            logger.error('Squad stderr', { squadId, output: data.toString().trim() });
        });
         squadProcess.on('error', (err) => {
            logger.error('Squad process error', { squadId, error: err });
            metrics.increment('squad_process_errors');
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
             logger.info('Squad process exited', { squadId, code, signal });
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
                 logger.debug('Cleaned up state for squad', { squadId });
                 if (code !== 0) {
                     metrics.increment('squad_unexpected_exits');
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

        logger.info('Squad spawned successfully', {
          squadId,
          pid: squadProcess.pid,
          assignedAgents: selectedAgents.map(a => a.agentId)
        });
        metrics.increment('squads_created');

    } catch (error) {
        logger.error('Error spawning squad leader process', { squadId, error });
        metrics.increment('squad_spawn_errors');
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
         logger.error('Cannot send init to Squad: Squad not found', { squadId });
         ws.close(1011, "Squad ID not recognized");
         return;
     }
     if (squad.ws) {
         logger.warn('Squad already has a WebSocket connection, ignoring new connection', { squadId });
         return;
     }

     logger.info('Squad Leader connected via WebSocket, sending init', { squadId });
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
             logger.warn('Agent or BSM address not found for squad init', { agentId, squadId });
             return null;
         }).filter(a => a !== null) as { agentId: string; bsmAddress: string }[]
     };

     if (initPayload.assignedAgents.length !== squad.agentIds.length) {
         logger.error('Error preparing init payload for Squad: Could not find BSM address for all assigned agents', { squadId });
         terminateSquadLeader(squadId, "Failed to find BSM addresses for all agents");
         return;
     }

     const message: WebSocketMessage = {
         type: 'squadLeader::init',
         payload: initPayload,
         senderId: 'orchestrator'
     };
     ws.send(JSON.stringify(message));
     logger.debug('Sent init to Squad', { squadId, agentCount: initPayload.assignedAgents.length });
     metrics.increment('squad_init_messages_sent');
}

function terminateSquadLeader(squadId: string, reason: string = "Mission ended") {
    const squad = activeSquads.get(squadId);
    if (!squad) {
        logger.warn('Cannot terminate Squad: Not found', { squadId });
        return;
    }
    logger.info('Terminating Squad Leader', { squadId, reason });

    if (squad.ws && squad.ws.readyState === WebSocket.OPEN) {
        try {
            const message: WebSocketMessage = { type: 'squadLeader::terminate', payload: { reason }, senderId: 'orchestrator' };
            squad.ws.send(JSON.stringify(message));
            squad.ws.close(1000, "Termination requested by Orchestrator");
        } catch (err) {
            logger.error('Error sending terminate message to Squad', { squadId, error: err });
        }
    } else {
         logger.warn('Squad WS connection not open for sending terminate message', { squadId });
    }

    if (squad.process && !squad.process.killed) {
        logger.debug('Sending SIGTERM to Squad Leader process', { squadId, pid: squad.process.pid });
        const killed = squad.process.kill('SIGTERM');
        if (!killed) {
             logger.warn('Failed to send SIGTERM to Squad Leader process', { squadId, pid: squad.process.pid });
        }
        setTimeout(() => {
            if (squad.process && !squad.process.killed) {
                logger.warn('Squad Leader did not terminate gracefully, sending SIGKILL', { squadId });
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
    logger.debug('Termination process complete, state cleaned', { squadId });
    metrics.increment('squads_terminated');
}


// --- World State Interface ---
async function queryWorldState(query: object): Promise<any> {
    logger.debug('Querying World State Service', { query });
    const startTime = Date.now();

    try {
        const params = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => {
            params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        });

        const response = await fetch(`${WORLD_STATE_API_ADDRESS}/query?${params.toString()}`);
        if (!response.ok) {
            logger.error('Error querying World State', {
              status: response.status,
              statusText: response.statusText
            });
            metrics.increment('world_state_query_errors');
            return null;
        }
        const results = await response.json();
        const duration = Date.now() - startTime;

        logger.debug('World State query completed', {
          resultCount: results?.length ?? 0,
          durationMs: duration
        });
        metrics.record('world_state_query_duration', duration);
        metrics.increment('world_state_queries_successful');
        return results;
    } catch (error) {
        logger.error('Fetch error querying World State', { error });
        metrics.increment('world_state_query_errors');
        return null;
    }
}


// --- WebSocket Server ---
const wss = new WebSocketServer({ port: WS_PORT });
logger.info('Orchestrator WebSocket server started', { port: WS_PORT });

wss.on('connection', (ws: WebSocket) => {
    logger.debug('WS Client connected to Orchestrator');
    metrics.increment('ws_connections');

    ws.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            logger.debug('Orchestrator received WS message', {
              type: parsedMessage.type,
              sender: parsedMessage.senderId
            });
            metrics.increment('ws_messages_received');

            // --- Handle BSM Registration ---
            if (parsedMessage.type === 'bsm::register') {
                const { bsmId, address, capacity, agents } = parsedMessage.payload;
                if (bsmId && address && agents && Array.isArray(agents)) {
                    logger.info(`BSM Registered: ${bsmId} at ${address} (Capacity: ${capacity || 'N/A'})`);
                    knownBSMs.set(bsmId, { address, ws });
                    agents.forEach((agentData: { agentId: string, status?: string }) => {
                        if (!knownAgents.has(agentData.agentId)) {
                             logger.info(`Registering new agent ${agentData.agentId} from BSM ${bsmId}`);
                             knownAgents.set(agentData.agentId, {
                                 agentId: agentData.agentId,
                                 bsmAddress: address,
                                 status: 'idle',
                                 currentSquadId: undefined,
                                 lastKnownLocation: undefined
                             });
                        } else {
                             logger.info(`Agent ${agentData.agentId} already known.`);
                             const agent = knownAgents.get(agentData.agentId);
                             if (agent) agent.bsmAddress = address;
                        }
                    });
                } else {
                     logger.error('Invalid bsm::register message payload:', parsedMessage.payload);
                }
            }
            // --- Handle Squad Leader Registration ---
            else if (parsedMessage.type === 'squadLeader::register') {
                 const squadId = parsedMessage.senderId;
                 if (squadId && activeSquads.has(squadId)) {
                     sendInitToSquadLeader(squadId, ws);
                 } else {
                     logger.error(`Received registration from unknown or inactive Squad ID: ${squadId}`);
                     ws.close(1008, "Unknown Squad ID");
                 }
            }
            // --- Handle Squad Leader Reports ---
            else if (parsedMessage.type === 'squadLeader::statusUpdate') {
                const { squadId, status, progress, details } = parsedMessage.payload;
                const squad = activeSquads.get(squadId);
                if (squad) {
                    logger.info(`Status update from Squad ${squadId}: ${status} (${(progress * 100).toFixed(1)}%)`);
                    squad.status = status;
                } else {
                     logger.warn(`Received status update for unknown squad: ${squadId}`);
                }
            } else if (parsedMessage.type === 'squadLeader::missionComplete') {
                 const { squadId, results } = parsedMessage.payload;
                 logger.info(`Mission complete for Squad ${squadId}:`, results);
                 terminateSquadLeader(squadId, "Mission Complete");
                 runStrategicPlanning({ type: 'missionComplete', squadId, results });
            } else if (parsedMessage.type === 'squadLeader::missionFailed') {
                 const { squadId, reason } = parsedMessage.payload;
                 logger.info(`Mission failed for Squad ${squadId}: ${reason}`);
                 terminateSquadLeader(squadId, `Mission Failed: ${reason}`);

                 // --- Nuanced Event Detection (Task 3.1) ---
                 const currentFailures = (squadFailureCounts.get(squadId) || 0) + 1;
                 squadFailureCounts.set(squadId, currentFailures);
                 logger.info(`Squad ${squadId} failure count: ${currentFailures}`);

                 const failureEvent: any = { type: 'missionFailed', squadId, reason };
                 if (currentFailures >= SQUAD_FAILURE_THRESHOLD) {
                     logger.warn(`Squad ${squadId} has failed ${currentFailures} times (>= threshold ${SQUAD_FAILURE_THRESHOLD}). Triggering specific re-plan.`);
                     failureEvent.type = 'repeatedSquadFailure'; // Modify event type
                     // Optionally reset count after triggering special re-plan
                     // squadFailureCounts.delete(squadId);
                 }
                 runStrategicPlanning(failureEvent);
                 // --- End Task 3.1 ---

            } else if (parsedMessage.type === 'squadLeader::reportStrategicFind') {
                 const { squadId, findingDetails } = parsedMessage.payload;
                 logger.info(`Strategic find reported by Squad ${squadId}:`, findingDetails);
                 runStrategicPlanning({ type: 'strategicFind', squadId, findingDetails });
            }
             // --- Handle Agent Lost ---
             else if (parsedMessage.type === 'squadLeader::agentLost') {
                 const { squadId, agentId, reason } = parsedMessage.payload;
                 logger.warn(`Agent ${agentId} lost from Squad ${squadId}. Reason: ${reason}`);
                 const agent = knownAgents.get(agentId);
                 if (agent) {
                     agent.status = 'unknown';
                     agent.currentSquadId = undefined;
                 }
                 runStrategicPlanning({ type: 'agentLost', agentId, squadId, reason });
             }
            // --- Handle Frontend Registration/Commands ---
            else if (parsedMessage.type === 'frontend::register') {
                logger.info('Frontend client registered.');
                connectedFrontendClients.add(ws);
            } else if (parsedMessage.type === 'frontend::startGoal') {
                 const { goal } = parsedMessage.payload;
                 logger.info(`Received start goal from frontend: ${goal}`);
                 runStrategicPlanning({ type: 'startGoal', goal });
            }

        } catch (error) {
            logger.error('Failed to parse Orchestrator WS message or handle:', error);
        }
    });

    ws.on('close', () => {
        logger.info('WS Client disconnected from Orchestrator');
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
             logger.info(`BSM ${disconnectedId} disconnected.`);
             const bsmAddress = knownBSMs.get(disconnectedId)?.address; // Get address before deleting
             knownBSMs.delete(disconnectedId);
             // Mark agents associated with this BSM as unknown
             knownAgents.forEach(agent => {
                 if (agent.bsmAddress === bsmAddress) {
                     agent.status = 'unknown';
                     logger.info(`Marked agent ${agent.agentId} as unknown due to BSM disconnect.`);
                 }
             });
        } else {
             for (const [id, squad] of activeSquads.entries()) {
                 if (squad.ws === ws) {
                     disconnectedId = id;
                     disconnectedType = 'squad';
                     logger.warn(`Squad Leader ${id} disconnected unexpectedly.`);
                     squad.ws = null;
                     break;
                 }
             }
        }
    });

    ws.on('error', (error: Error) => {
        logger.error('Orchestrator WebSocket error:', error);
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

// --- Health Check Setup ---
const healthCheck = new HealthCheck('orchestrator-service', '0.1.0');

healthCheck.registerDependency('world-state-service', async () => {
    try {
        const response = await fetch(`${WORLD_STATE_API_ADDRESS}/health`, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
            return { status: 'connected' };
        }
        return { status: 'disconnected', error: 'World State unhealthy' };
    } catch (error) {
        return { status: 'disconnected', error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

healthCheck.registerDependency('gemini-api', async () => {
    // Check circuit breaker state
    const cbState = geminiCircuitBreaker.getState();
    if (cbState === 'open') {
        return { status: 'degraded', error: 'Circuit breaker open' };
    }
    return { status: 'connected' };
});

// --- HTTP Server with Health and Metrics Endpoints ---
const server = http.createServer(async (req, res) => {
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
                service: 'orchestrator-service',
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
        status: 'Orchestrator Running',
        knownBSMs: knownBSMs.size,
        knownAgents: knownAgents.size,
        activeSquads: activeSquads.size
    }));
});

server.listen(PORT, () => {
    logger.info('Orchestrator HTTP server listening', {
      port: PORT,
      endpoints: ['/health', '/metrics', '/']
    });
});


// --- Initial Startup ---
logger.info("Orchestrator started. Waiting for connections...");


// --- Graceful Shutdown ---
const shutdown = createGracefulShutdown(logger);

shutdown.register(async () => {
    logger.info('Closing WebSocket server...');
    wss.close();
});

shutdown.register(async () => {
    logger.info('Closing HTTP server...');
    return new Promise<void>((resolve) => {
        server.close(() => {
            logger.info('HTTP server closed');
            resolve();
        });
    });
});

shutdown.register(async () => {
    logger.info('Terminating all active squad leaders...');
    const squadTerminations = Array.from(activeSquads.keys()).map(squadId => {
        return new Promise<void>((resolve) => {
            terminateSquadLeader(squadId, "Orchestrator shutting down");
            resolve();
        });
    });
    await Promise.all(squadTerminations);
    logger.info('All squad leaders terminated');
});
