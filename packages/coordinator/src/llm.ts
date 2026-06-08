/**
 * Conversational Coordinator LLM — Gemini 3 Flash with function calling.
 *
 * Event-driven agent that manages a goal board, assigns tasks to agents with
 * completion conditions, converses with players, and uses the task tree resolver
 * as one tool among many.
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { createLogger, metrics, CircuitBreaker, RateLimiter } from '@aetherius/shared-types';
import { AgentManager } from './agents';
import { WorldStateClient } from './world-state';
import { GoalBoard } from './goal-board';
import { initRecipes } from './task-tree/recipes';
import { SYSTEM_PROMPT } from './llm-prompt';
import { COORDINATOR_TOOLS } from './llm-tools';
import { executeTool, ToolContext } from './llm-executor';

const logger = createLogger('coordinator:llm');
const MODEL = 'gemini-3-flash-preview';
const MAX_TURNS_PER_INVOCATION = 10;

// --- Coordinator LLM Class ---

export class CoordinatorLLM {
  private genAI: GoogleGenAI;
  private agents: AgentManager;
  private worldState: WorldStateClient;
  private goalBoard: GoalBoard;
  private mcVersion: string;

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
    this.mcVersion = mcVersion;

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
          const ctx = this.buildToolContext();
          const functionResponseParts: any[] = [];
          for (const call of functionCalls) {
            const result = await executeTool(call.name!, call.args, ctx);
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
      logger.error('Coordinator invocation failed', { error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
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

  /** Build the context object the extracted tool executor needs. */
  private buildToolContext(): ToolContext {
    return {
      agents: this.agents,
      worldState: this.worldState,
      goalBoard: this.goalBoard,
      mcVersion: this.mcVersion,
    };
  }
}
