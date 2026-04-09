/**
 * Conversational Coordinator LLM — Gemini 3 Flash with function calling.
 *
 * Event-driven agent that manages a goal board, assigns tasks to agents with
 * completion conditions, converses with players, and uses the task tree resolver
 * as one tool among many.
 */

import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { createLogger, metrics, CompletionCondition, CircuitBreaker, LLMCache, RateLimiter } from '@aetherius/shared-types';
import { AgentManager } from './agents';
import { WorldStateClient } from './world-state';
import { GoalBoard } from './goal-board';
import { resolveGoal, TaskNode } from './task-tree/resolver';
import { initRecipes } from './task-tree/recipes';

const logger = createLogger('coordinator:llm');
const MODEL = 'gemini-3-flash-preview';
const MAX_TURNS_PER_INVOCATION = 10;

// --- Behavior Profile Presets ---
const PROFILE_PRESETS: Record<string, any> = {
  cautious: {
    retreatHealthThreshold: 0.5, foodReserveMinimum: 4, hungerEatThreshold: 14,
    mobEngagementPolicy: 'avoid', hostileDetectionRadius: 24, creepAvoidanceRadius: 8,
    playerResponsePolicy: 'hide', playerDetectionRadius: 32,
    allowNightSurface: false, allowLavaProximity: 5, maxYDepth: 0,
    inventoryDropPriority: ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'rotten_flesh'],
    keepToolsMinimum: { pickaxe: 1, sword: 1 }, maxExplorationRange: 1000, placeTorchesWhileMining: true,
  },
  balanced: {
    retreatHealthThreshold: 0.3, foodReserveMinimum: 2, hungerEatThreshold: 14,
    mobEngagementPolicy: 'auto', hostileDetectionRadius: 16, creepAvoidanceRadius: 8,
    playerResponsePolicy: 'avoid', playerDetectionRadius: 32,
    allowNightSurface: true, allowLavaProximity: 3, maxYDepth: -64,
    inventoryDropPriority: ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'rotten_flesh'],
    keepToolsMinimum: { pickaxe: 1 }, maxExplorationRange: 1000, placeTorchesWhileMining: true,
  },
  aggressive: {
    retreatHealthThreshold: 0.15, foodReserveMinimum: 1, hungerEatThreshold: 10,
    mobEngagementPolicy: 'engage', hostileDetectionRadius: 16, creepAvoidanceRadius: 8,
    playerResponsePolicy: 'ignore', playerDetectionRadius: 32,
    allowNightSurface: true, allowLavaProximity: 1, maxYDepth: -64,
    inventoryDropPriority: ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'rotten_flesh'],
    keepToolsMinimum: {}, maxExplorationRange: 2000, placeTorchesWhileMining: false,
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Coordinator AI for Aetherius, a Minecraft bot swarm controlled by a human player.

## Your Role
You manage a GOAL BOARD of concurrent goals, assign tasks to agents, and converse with the human player via Minecraft chat. You are invoked whenever something happens: a player speaks, an agent finishes or fails a task, a behavior alert fires, or on a periodic 60-second timer.

## Available Tools

### Agent Management
- **assignTask**: Assign a module to an idle agent with parameters and an optional completion condition. The agent runs the module autonomously until the condition is met or the module finishes on its own.
- **cancelTask**: Cancel an agent's current task. The agent becomes idle.
- **updateAgentProfile**: Change an agent's behavior profile (cautious/balanced/aggressive) without interrupting its current task.

### Planning
- **resolveTaskTree**: For ACQUISITION goals only. Given an item name and count, returns the full dependency tree (mining, smelting, crafting steps) pruned against current inventories. Use this to figure out what tasks to assign for crafting goals. Do NOT invent recipes yourself — always use this tool.
- **queryWorldState**: Query the world state database for POIs, resources, chest contents, or infrastructure.

### Goal Management
- **createGoal**: Add a new goal to the board.
- **updateGoal**: Modify a goal's priority, status, assigned agents, or state.
- **completeGoal**: Mark a goal as completed.
- **pauseGoal** / **resumeGoal**: Temporarily pause or resume a goal.

### Communication
- **messagePlayer**: Send a chat message to the Minecraft server via an agent. Use this to respond to player messages, ask clarifying questions, report progress, or acknowledge requests.

## Modules You Can Assign
Each agent runs ONE module at a time. Available modules and their key parameters:

- **Gather**: \`{ targetType: "block"|"entity"|"fishing", target: string, quantity: number, maxY?: number }\`
- **Craft**: \`{ item: string, quantity: number }\` — requires ingredients in inventory, will fail with missing list if not
- **Smelt**: \`{ input: string, fuel: string, quantity: number }\` — finds/places furnace, waits for completion
- **NavigateTo**: \`{ targetCoords: {x,y,z} }\`
- **Explore**: \`{ goal: "find_structure"|"find_block"|"find_biome"|"scout_area", structureType?: string, blockType?: string, maxRadius?: number }\`
- **Guard**: \`{ mode: "patrol"|"defensive", patrolArea?: {center:{x,y,z}, radius:number}, engagementPolicy: "engage"|"avoid"|"auto", targetPriority: ["hostile"|"player"] }\`
- **Attack**: \`{ targetEntityId: string }\`
- **Build**: \`{ schematic: "nether_portal", origin: {x,y,z} }\` or \`{ blocks: [{pos:{x,y,z}, block:string}] }\`
- **ManageContainer**: \`{ action: "take"|"deposit"|"search", containerCoords?: {x,y,z}, items?: [{item,count}], searchRadius?: number, lookingFor?: string[] }\`
- **Transport**: \`{ targetAgent: string, items: [{item,count}] }\` — tosses items to another agent

## Completion Conditions
When assigning a task, you can set an optional completion condition. The task ends when EITHER the module finishes OR the condition evaluates true, whichever comes first.

- \`{ type: "inventory_has", item: string, count: number }\` — agent has ≥ count of item
- \`{ type: "at_position", position: {x,y,z}, radius: number }\` — agent within radius
- \`{ type: "time_elapsed", seconds: number }\` — time since assignment
- \`{ type: "entity_eliminated", entityType: string, radius: number }\` — no entities of type in radius
- \`{ type: "structure_found", structureType: string }\` — structure detector logged a match
- \`{ type: "area_cleared", radius: number }\` — no hostiles in radius
- \`{ type: "indefinite" }\` — runs until you cancel it (use for persistent tasks like patrol)

## Behavior Profiles
Set per-agent to control autonomous survival behaviors:
- **cautious**: retreat at 50% health, avoid mobs, hide from players, no night surface
- **balanced**: retreat at 30% health, auto-engage mobs, avoid players
- **aggressive**: retreat at 15% health, engage everything, max exploration range

## Guidelines
1. **Respond to every player message.** Even just "Got it" or "Working on it." Use messagePlayer.
2. **Create goals for player requests.** When the player asks for something, create a goal first, then plan tasks.
3. **Use resolveTaskTree for crafting/acquisition.** Never guess recipes. The task tree has correct data.
4. **Assign one task at a time per agent.** You'll be invoked again when they finish.
5. **Respect dependency order.** Don't assign "craft iron_pickaxe" before iron_ingot gathering is done.
6. **Parallelize independent tasks.** Multiple agents can mine different resources simultaneously.
7. **React to alerts proportionally.** Night shelter → usually ignore (behavior layer handles it). Agent death → replan. Player detected → inform the human player.
8. **Use periodic invocations to optimize.** Check for idle agents, stalled goals, reallocation opportunities.
9. **Complete goals when done.** Call completeGoal when all tasks for a goal are satisfied.
10. **Handle failure gracefully.** If a task fails, analyze why (from the event details) and reassign or adapt.`;

// --- Tool Definitions ---
const COORDINATOR_TOOLS = [
  {
    name: 'assignTask',
    description: 'Assign a module task to an idle agent with optional completion condition and behavior profile.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'ID of the idle agent.' },
        taskType: { type: Type.STRING, description: 'Task type: Gather, Craft, Smelt, NavigateTo, Explore, Guard, Attack, Build, PlaceBlock, ManageContainer, Transport.' },
        taskDetails: { type: Type.OBJECT, description: 'Module-specific parameters.', properties: {} },
        completionCondition: { type: Type.OBJECT, description: 'Optional completion condition. Omit for module-default completion.', properties: {} },
        behaviorProfile: { type: Type.STRING, description: 'Optional profile preset: "cautious", "balanced", "aggressive".' },
      },
      required: ['agentId', 'taskType', 'taskDetails'],
    },
  },
  {
    name: 'cancelTask',
    description: 'Cancel an agent\'s current task. Agent becomes idle.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'Agent to cancel.' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'updateAgentProfile',
    description: 'Update an agent\'s behavior profile without changing its current task.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'Agent to update.' },
        profile: { type: Type.STRING, description: 'Profile preset: "cautious", "balanced", "aggressive".' },
      },
      required: ['agentId', 'profile'],
    },
  },
  {
    name: 'resolveTaskTree',
    description: 'Resolve an item\'s crafting dependency tree. Returns ordered task list pruned against current inventories. Use for acquisition goals ONLY.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        item: { type: Type.STRING, description: 'Item name (e.g., "diamond_pickaxe").' },
        count: { type: Type.NUMBER, description: 'How many to obtain.' },
      },
      required: ['item', 'count'],
    },
  },
  {
    name: 'queryWorldState',
    description: 'Query the world state database for POIs, resources, storage contents, or infrastructure.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.OBJECT, description: 'Query params: {type: "poi"|"resourceNode"|"infrastructure", filter: {...}, options: {limit: N}}', properties: {} },
      },
      required: ['query'],
    },
  },
  {
    name: 'createGoal',
    description: 'Create a new goal on the goal board.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: 'What the goal is (e.g., "Obtain full netherite armor").' },
        type: { type: Type.STRING, description: 'Goal type: acquisition, persistent, construction, exploration, social, composite.' },
        priority: { type: Type.STRING, description: 'Priority: critical, high, medium, low.' },
      },
      required: ['description', 'type', 'priority'],
    },
  },
  {
    name: 'updateGoal',
    description: 'Update a goal\'s priority, assignedAgents, or state.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goalId: { type: Type.STRING, description: 'Goal ID to update.' },
        priority: { type: Type.STRING, description: 'New priority.' },
        assignedAgents: { type: Type.ARRAY, description: 'Agent IDs assigned to this goal.', items: { type: Type.STRING } },
        state: { type: Type.OBJECT, description: 'Goal-specific state update.', properties: {} },
      },
      required: ['goalId'],
    },
  },
  {
    name: 'completeGoal',
    description: 'Mark a goal as completed.',
    parameters: {
      type: Type.OBJECT,
      properties: { goalId: { type: Type.STRING } },
      required: ['goalId'],
    },
  },
  {
    name: 'pauseGoal',
    description: 'Pause a goal. Agents on only this goal become idle.',
    parameters: {
      type: Type.OBJECT,
      properties: { goalId: { type: Type.STRING } },
      required: ['goalId'],
    },
  },
  {
    name: 'resumeGoal',
    description: 'Resume a paused goal.',
    parameters: {
      type: Type.OBJECT,
      properties: { goalId: { type: Type.STRING } },
      required: ['goalId'],
    },
  },
  {
    name: 'messagePlayer',
    description: 'Send a chat message to the Minecraft server. The message appears in-game.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: { type: Type.STRING, description: 'The chat message to send.' },
      },
      required: ['message'],
    },
  },
];

// --- Coordinator LLM Class ---

export class CoordinatorLLM {
  private genAI: GoogleGenAI;
  private agents: AgentManager;
  private worldState: WorldStateClient;
  private goalBoard: GoalBoard;

  private circuitBreaker: CircuitBreaker;
  private rateLimiter: RateLimiter;
  private conversationHistory: Array<{ role: string; parts: any[] }> = [];

  private isRunning = false;
  private pendingEvents: any[] = [];

  constructor(
    apiKey: string,
    agents: AgentManager,
    worldState: WorldStateClient,
    goalBoard: GoalBoard,
    mcVersion: string,
  ) {
    this.genAI = new GoogleGenAI({ apiKey });
    this.agents = agents;
    this.worldState = worldState;
    this.goalBoard = goalBoard;

    initRecipes(mcVersion);

    this.circuitBreaker = new CircuitBreaker('gemini-api', {
      failureThreshold: 5,
      resetTimeout: 60000,
      onStateChange: (state) => logger.warn('Gemini circuit breaker state changed', { state }),
    });
    this.rateLimiter = new RateLimiter({ maxCalls: 60, windowMs: 60000 });

    logger.info('Conversational coordinator initialized', { model: MODEL });
  }

  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  /** Main entry point — invoke the coordinator on any event. */
  async invoke(triggeringEvent: any): Promise<void> {
    if (this.isRunning) {
      this.pendingEvents.push(triggeringEvent);
      logger.debug('Coordinator busy, event queued', { queueSize: this.pendingEvents.length });
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    metrics.increment('coordinator_invocations');

    try {
      // Build context
      const [goalSummary, worldSummary] = await Promise.all([
        this.goalBoard.getGoalSummary(),
        this.worldState.getWorldSummary(),
      ]);

      const agentSummary = this.agents.getAllAgents().map(a => ({
        id: a.agentId,
        status: a.status,
        position: a.lastKnownLocation,
        inventory: a.inventoryMap,
        currentTask: a.currentTaskType,
        currentTaskId: a.currentTaskId,
      }));

      // Build user message
      const userMessage = this.buildContextMessage(triggeringEvent, agentSummary, worldSummary, goalSummary);
      this.conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });

      // Prune history to last 20 turns
      if (this.conversationHistory.length > 40) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      // Multi-turn tool use loop
      await this.rateLimiter.waitIfNeeded();
      let turns = 0;

      while (turns < MAX_TURNS_PER_INVOCATION) {
        turns++;

        const response = await metrics.measureAsync('llm_coordinator_call', async () => {
          return await this.circuitBreaker.execute(async () => {
            return await this.genAI.models.generateContent({
              model: MODEL,
              contents: this.conversationHistory as any,
              config: {
                systemInstruction: SYSTEM_PROMPT,
                tools: [{ functionDeclarations: COORDINATOR_TOOLS as any }],
                thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
              },
            });
          });
        });

        if (!response) {
          logger.error('Null response from Gemini');
          break;
        }

        const functionCalls = response.functionCalls;

        if (functionCalls && functionCalls.length > 0) {
          metrics.increment('llm_function_calls', functionCalls.length);

          // Add model response to history (preserves thought signatures)
          if (response.candidates?.[0]?.content) {
            this.conversationHistory.push(response.candidates[0].content as any);
          }

          // Execute function calls
          const functionResponseParts: any[] = [];
          for (const call of functionCalls) {
            const result = await this.executeTool(call.name!, call.args);
            functionResponseParts.push({
              functionResponse: { name: call.name, response: result, id: call.id },
            });
          }

          // Add responses to history
          this.conversationHistory.push({ role: 'user', parts: functionResponseParts });

          await this.rateLimiter.waitIfNeeded();
        } else {
          // No function calls — final text response
          const text = response.text;
          if (text) {
            logger.info('Coordinator reasoning complete', { preview: text.substring(0, 200) });
          }
          // Add model's final response to history
          if (response.candidates?.[0]?.content) {
            this.conversationHistory.push(response.candidates[0].content as any);
          }
          break;
        }
      }

      if (turns >= MAX_TURNS_PER_INVOCATION) {
        logger.warn('Coordinator hit max turns limit');
      }

      metrics.record('coordinator_invocation_duration', Date.now() - startTime);
    } catch (error) {
      logger.error('Coordinator invocation failed', { error });
      metrics.increment('coordinator_errors');
    } finally {
      this.isRunning = false;
      // Process next queued event
      if (this.pendingEvents.length > 0) {
        const next = this.pendingEvents.shift();
        // Small delay to avoid tight loops
        setTimeout(() => this.invoke(next), 100);
      }
    }
  }

  // --- Context Builder ---

  private buildContextMessage(
    event: any,
    agents: any[],
    worldSummary: string,
    goalSummary: string,
  ): string {
    const parts: string[] = [];

    parts.push(`## Goal Board\n${goalSummary}`);

    parts.push(`\n## Agents (${agents.filter(a => a.status === 'idle').length} idle, ${agents.filter(a => a.status === 'busy').length} busy)`);
    for (const a of agents) {
      const pos = a.position ? `(${a.position.x}, ${a.position.y}, ${a.position.z})` : '(unknown)';
      const invEntries = Object.entries(a.inventory ?? {});
      const inv = invEntries.length > 0 ? invEntries.map(([k, v]) => `${k}:${v}`).join(', ') : 'empty';
      parts.push(`- **${a.id}**: ${a.status} at ${pos} | Task: ${a.currentTask ?? 'idle'} | Inv: {${inv}}`);
    }

    parts.push(`\n## World State\n\`\`\`json\n${worldSummary}\n\`\`\``);

    parts.push(`\n## Triggering Event`);
    if (event.type === 'playerChat') {
      parts.push(`**Player "${event.playerName}" said:** "${event.message}"`);
      parts.push(`\nRespond to this player using the messagePlayer tool. Then handle any request they made.`);
    } else if (event.type === 'periodic') {
      parts.push(`Periodic check (60s timer). Review goal progress, check for idle agents, optimize allocations.`);
    } else if (event.type === 'startGoal') {
      parts.push(`New goal request from frontend: "${event.goal}" (count: ${event.count ?? 1})`);
      parts.push(`Create a goal and start planning.`);
    } else {
      parts.push(`\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``);
    }

    return parts.join('\n');
  }

  // --- Tool Executor ---

  private async executeTool(name: string, args: any): Promise<any> {
    logger.debug('Executing tool', { name, args });

    switch (name) {
      case 'assignTask': {
        const { agentId, taskType, taskDetails, completionCondition, behaviorProfile } = args;

        // Apply profile if specified
        if (behaviorProfile) {
          const profile = PROFILE_PRESETS[behaviorProfile] ?? PROFILE_PRESETS.balanced;
          this.agents.sendProfile(agentId, profile);
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;

        // Parse completion condition if provided
        let condition: CompletionCondition | undefined;
        if (completionCondition && completionCondition.type) {
          condition = completionCondition as CompletionCondition;
        }

        const success = this.agents.sendCommand(agentId, taskId, { type: taskType, details: taskDetails }, condition);
        metrics.increment('tasks_assigned');
        return success
          ? { success: true, taskId, status: `Assigned ${taskType} to ${agentId}` }
          : { success: false, error: `Failed to assign to ${agentId} — check agent exists and BSM is connected` };
      }

      case 'cancelTask': {
        const success = this.agents.cancelTask(args.agentId);
        return { success, status: success ? 'Task cancelled' : 'Failed to cancel' };
      }

      case 'updateAgentProfile': {
        const profile = PROFILE_PRESETS[args.profile] ?? PROFILE_PRESETS.balanced;
        const success = this.agents.sendProfile(args.agentId, profile);
        return { success, status: success ? 'Profile updated' : 'Failed to update' };
      }

      case 'resolveTaskTree': {
        const inventories = this.agents.getInventories();
        const storage = await this.worldState.getStorageContents();
        const tasks = resolveGoal(args.item, args.count ?? 1, inventories, storage);
        return {
          taskCount: tasks.length,
          tasks: tasks.map(t => ({
            id: t.id, item: t.item, count: t.count, method: t.method,
            taskType: t.details.taskType, taskDetails: t.details.taskDetails,
            dependsOn: t.dependsOn,
          })),
        };
      }

      case 'queryWorldState': {
        const result = await this.worldState.query(args.query);
        return { success: true, result: result ?? 'No results' };
      }

      case 'createGoal': {
        const goal = await this.goalBoard.createGoal({
          type: args.type,
          description: args.description,
          priority: args.priority ?? 'medium',
          state: args.state,
        });
        return goal
          ? { success: true, goalId: goal.goalId, status: 'Goal created' }
          : { success: false, error: 'Failed to create goal' };
      }

      case 'updateGoal': {
        const { goalId, ...updates } = args;
        const goal = await this.goalBoard.updateGoal(goalId, updates);
        return goal
          ? { success: true, status: 'Goal updated' }
          : { success: false, error: 'Goal not found' };
      }

      case 'completeGoal': {
        const goal = await this.goalBoard.completeGoal(args.goalId);
        return goal
          ? { success: true, status: 'Goal completed' }
          : { success: false, error: 'Goal not found' };
      }

      case 'pauseGoal': {
        const goal = await this.goalBoard.pauseGoal(args.goalId);
        return goal
          ? { success: true, status: 'Goal paused' }
          : { success: false, error: 'Goal not found' };
      }

      case 'resumeGoal': {
        const goal = await this.goalBoard.resumeGoal(args.goalId);
        return goal
          ? { success: true, status: 'Goal resumed' }
          : { success: false, error: 'Goal not found' };
      }

      case 'messagePlayer': {
        // Send via any available agent
        const anyAgent = this.agents.getAllAgents().find(a => a.status !== 'unknown');
        if (!anyAgent) {
          return { success: false, error: 'No agents available to send chat' };
        }
        const success = this.agents.sendChatMessage(anyAgent.agentId, args.message);
        return { success, status: success ? 'Message sent' : 'Failed to send' };
      }

      default:
        logger.warn('Unknown tool call', { name });
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }
}
