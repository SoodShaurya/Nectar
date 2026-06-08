/**
 * Conversational Coordinator LLM — DeepSeek (v4-pro) with function calling.
 *
 * Event-driven agent that manages a goal board, assigns tasks to agents with
 * completion conditions, converses with players, and uses the task tree resolver
 * as one tool among many.
 *
 * DeepSeek is OpenAI-compatible: we talk to it via the `openai` SDK pointed at
 * the DeepSeek base URL, using OpenAI-format chat messages and tool calling.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createLogger, metrics, CircuitBreaker, RateLimiter } from '@aetherius/shared-types';
import { AgentManager } from './agents';
import { WorldStateClient } from './world-state';
import { GoalBoard } from './goal-board';
import { initRecipes } from './task-tree/recipes';
import { SYSTEM_PROMPT } from './llm-prompt';
import { COORDINATOR_TOOLS } from './llm-tools';
import { executeTool, ToolContext } from './llm-executor';

const logger = createLogger('coordinator:llm');
const MODEL = 'deepseek-v4-pro';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const MAX_TURNS_PER_INVOCATION = 10;

// --- Coordinator LLM Class ---

export class CoordinatorLLM {
  private client: OpenAI;
  private agents: AgentManager;
  private worldState: WorldStateClient;
  private goalBoard: GoalBoard;
  private mcVersion: string;

  private circuitBreaker: CircuitBreaker;
  private rateLimiter: RateLimiter;
  // OpenAI-format chat history (user / assistant / tool messages). The system
  // prompt is prepended fresh on every request and is NOT stored here.
  private conversationHistory: ChatCompletionMessageParam[] = [];

  private isRunning = false;
  private pendingEvents: any[] = [];
  /** Timestamp of the most recent invocation (any event). Lets the supervisor
   *  tick suppress the periodic backstop while the event stream is active. */
  private lastInvokeAt = 0;

  constructor(
    apiKey: string,
    agents: AgentManager,
    worldState: WorldStateClient,
    goalBoard: GoalBoard,
    mcVersion: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
    this.agents = agents;
    this.worldState = worldState;
    this.goalBoard = goalBoard;
    this.mcVersion = mcVersion;

    initRecipes(mcVersion);

    this.circuitBreaker = new CircuitBreaker('deepseek-api', {
      failureThreshold: 5,
      resetTimeout: 60000,
      onStateChange: (state) => logger.warn('DeepSeek circuit breaker state changed', { state }),
    });
    this.rateLimiter = new RateLimiter({ maxCalls: 60, windowMs: 60000 });

    logger.info('Conversational coordinator initialized', { model: MODEL });
  }

  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  /** Whether an invocation is currently in flight (so the supervisor doesn't pile on). */
  isBusy(): boolean {
    return this.isRunning;
  }

  /** Timestamp (ms) of the most recent invocation, or 0 if never invoked. */
  getLastInvokeTime(): number {
    return this.lastInvokeAt;
  }

  /** Main entry point — invoke the coordinator on any event. */
  async invoke(triggeringEvent: any): Promise<void> {
    // Mark activity for any invocation attempt (even one that queues) so the
    // supervisor's quiet-backstop gate reflects real coordinator attention.
    this.lastInvokeAt = Date.now();

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
      this.conversationHistory.push({ role: 'user', content: userMessage });

      // Prune history to last 20 messages. Guard against orphaning a 'tool'
      // message at the front (a 'tool' role must be preceded by the assistant
      // message that requested it, or the API rejects the request).
      if (this.conversationHistory.length > 40) {
        this.conversationHistory = this.conversationHistory.slice(-20);
        while (this.conversationHistory.length > 0 && this.conversationHistory[0].role === 'tool') {
          this.conversationHistory.shift();
        }
      }

      // Multi-turn tool use loop
      await this.rateLimiter.waitIfNeeded();
      let turns = 0;

      while (turns < MAX_TURNS_PER_INVOCATION) {
        turns++;

        const response = await metrics.measureAsync('llm_coordinator_call', async () => {
          return await this.circuitBreaker.execute(async () => {
            return await this.client.chat.completions.create({
              model: MODEL,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...this.conversationHistory,
              ],
              tools: COORDINATOR_TOOLS,
              tool_choice: 'auto',
            });
          });
        });

        if (!response) {
          logger.error('Null response from DeepSeek');
          break;
        }

        const choice = response.choices?.[0];
        const message = choice?.message;
        if (!message) {
          logger.error('DeepSeek response had no choices/message');
          break;
        }

        const toolCalls = message.tool_calls;

        if (toolCalls && toolCalls.length > 0) {
          metrics.increment('llm_function_calls', toolCalls.length);

          // Append the assistant message verbatim — it carries the tool_calls
          // that the subsequent 'tool' messages must answer (matched by id).
          this.conversationHistory.push(message);

          // Execute tool calls and append one 'tool' message per result.
          const ctx = this.buildToolContext();
          for (const call of toolCalls) {
            // DeepSeek/OpenAI may emit non-function tool calls in theory; guard.
            if (call.type !== 'function') {
              logger.warn('Ignoring non-function tool call', { type: (call as any).type, id: call.id });
              this.conversationHistory.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ error: 'Unsupported tool call type' }),
              });
              continue;
            }

            const name = call.function.name;
            let args: any = {};
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch (err) {
              logger.warn('Failed to parse tool call arguments JSON', {
                name,
                arguments: call.function.arguments,
                error: err instanceof Error ? err.message : String(err),
              });
              this.conversationHistory.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ error: 'Invalid tool arguments JSON' }),
              });
              continue;
            }

            const result = await executeTool(name, args, ctx);
            this.conversationHistory.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(result ?? null),
            });
          }

          await this.rateLimiter.waitIfNeeded();
        } else {
          // No tool calls — final text response.
          const text = typeof message.content === 'string' ? message.content : '';
          if (text) {
            logger.info('Coordinator reasoning complete', { preview: text.substring(0, 200) });
          }

          // DEFENSIVE: some models leak a tool invocation into message.content as
          // text while reporting finish_reason 'stop'. We can't reliably execute
          // a malformed call, so log it and end the turn gracefully rather than
          // crash or loop.
          if (choice?.finish_reason === 'stop' && /"?(tool_call|function)"?\s*[:=]/i.test(text)) {
            logger.warn('Possible tool call leaked into assistant content; ending turn', {
              preview: text.substring(0, 300),
            });
          }

          // Add the model's final response to history.
          this.conversationHistory.push(message);
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
      const reason = event.reason ? ` (${event.reason})` : '';
      parts.push(`Periodic backstop check${reason}. The event stream has been quiet despite open work. Review goal progress, allocate any idle agents to ready work, and optimize. If there is genuinely nothing actionable, take no action.`);
    } else if (event.type === 'stall') {
      const secs = Math.round((event.elapsedMs ?? 0) / 1000);
      parts.push(`**Stall watchdog:** Agent "${event.agentId}" has been running ${event.taskType ?? 'a task'} (${event.taskId ?? 'unknown'}) for ${secs}s with no completion event.`);
      parts.push(`Decide: keep waiting (if this task type plausibly takes this long and is making progress), cancel and reassign, or adjust the plan. Do NOT reflexively cancel a legitimately long task.`);
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
