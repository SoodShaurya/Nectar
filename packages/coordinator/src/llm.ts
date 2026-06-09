/**
 * Conversational Coordinator LLM — DeepSeek (v4 family) with function calling.
 * Model is configurable via COORDINATOR_MODEL (deepseek-v4-flash default,
 * deepseek-v4-pro for deepest planning).
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
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const MAX_TURNS_PER_INVOCATION = 10;

// --- Coordinator LLM Class ---

export class CoordinatorLLM {
  private client: OpenAI;
  private agents: AgentManager;
  private worldState: WorldStateClient;
  private goalBoard: GoalBoard;
  private mcVersion: string;
  private model: string;

  private circuitBreaker: CircuitBreaker;
  private rateLimiter: RateLimiter;
  // OpenAI-format chat history (user / assistant / tool messages). The system
  // prompt is prepended fresh on every request and is NOT stored here.
  private conversationHistory: ChatCompletionMessageParam[] = [];

  private isRunning = false;
  private pendingEvents: any[] = [];
  /** Optional sink that mirrors coordinator chat replies to the web frontend.
   *  Set post-construction via setChatNotifier(); undefined until then. */
  private chatNotifier?: (message: string) => void;
  /** Timestamp of the most recent invocation (any event). Lets the supervisor
   *  tick suppress the periodic backstop while the event stream is active. */
  private lastInvokeAt = 0;

  constructor(
    apiKey: string,
    agents: AgentManager,
    worldState: WorldStateClient,
    goalBoard: GoalBoard,
    mcVersion: string,
    model: string = DEFAULT_MODEL,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
    this.agents = agents;
    this.worldState = worldState;
    this.goalBoard = goalBoard;
    this.mcVersion = mcVersion;
    this.model = model;

    initRecipes(mcVersion);

    this.circuitBreaker = new CircuitBreaker('deepseek-api', {
      failureThreshold: 5,
      resetTimeout: 60000,
      // Per-call timeout well above observed worst-case reasoning latency (~60s)
      // so a slow-but-successful turn is not miscounted as a failure and the
      // breaker doesn't trip open on legitimate slow reasoning.
      timeout: 120000,
      onStateChange: (state) => logger.warn('DeepSeek circuit breaker state changed', { state }),
    });
    // throwOnLimit:false so waitIfNeeded() actually sleeps until a slot frees
    // (matching its name) instead of throwing and aborting an invocation
    // mid-plan after tool side effects have already dispatched.
    this.rateLimiter = new RateLimiter({ maxCalls: 60, windowMs: 60000, throwOnLimit: false });

    logger.info('Conversational coordinator initialized', { model: this.model });
  }

  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Register the callback used to mirror coordinator chat replies (the
   * messagePlayer tool) to the web frontend. Set once at startup by index.ts.
   */
  setChatNotifier(fn: (message: string) => void): void {
    this.chatNotifier = fn;
  }

  /**
   * Append an assistant message to history with `reasoning_content` stripped.
   * DeepSeek ignores reasoning_content on input, but keeping it re-uploads
   * 150-350 tokens/turn and crowds the retained window. content + tool_calls
   * are preserved (tool_calls are required to match subsequent 'tool' messages).
   */
  private pushAssistantMessage(message: any): void {
    const { reasoning_content, ...clean } = message ?? {};
    this.conversationHistory.push(clean);
  }

  /**
   * Enqueue an event that arrived while an invocation was in flight. Bounded and
   * coalescing so a slow invocation under a burst can't grow the queue without
   * limit or replay redundant work:
   *  - Agent lifecycle events (replan/taskRejected/taskComplete/taskFailed) are
   *    deduped by agentId — only the latest per agent survives.
   *  - Total length is capped (oldest dropped) as a memory backstop.
   * (periodic/stall never reach here: the supervisor skips invoking while busy.)
   */
  private enqueuePendingEvent(event: any): void {
    const COALESCE = new Set(['replan', 'taskRejected', 'taskComplete', 'taskFailed']);
    const MAX_PENDING = 50;
    if (event?.type && COALESCE.has(event.type) && event.agentId) {
      this.pendingEvents = this.pendingEvents.filter(
        (e) => !(e?.type === event.type && e?.agentId === event.agentId),
      );
    }
    this.pendingEvents.push(event);
    if (this.pendingEvents.length > MAX_PENDING) {
      const dropped = this.pendingEvents.shift();
      logger.warn('Pending event queue full — dropped oldest', { droppedType: dropped?.type });
      metrics.increment('coordinator_pending_dropped');
    }
    logger.debug('Coordinator busy, event queued', { queueSize: this.pendingEvents.length });
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
      this.enqueuePendingEvent(triggeringEvent);
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
              model: this.model,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...this.conversationHistory,
              ],
              tools: COORDINATOR_TOOLS,
              tool_choice: 'auto',
              // Cap any single response so a runaway/looping reasoning_content
              // (a known reasoning-model failure mode) can't stream unbounded;
              // normal turns use only 150-350 reasoning tokens.
              max_tokens: 4096,
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

          // Append the assistant message — it carries the tool_calls that the
          // subsequent 'tool' messages must answer (matched by id). reasoning_content
          // is stripped (DeepSeek ignores it on input; keeping it wastes tokens).
          this.pushAssistantMessage(message);

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

          // Add the model's final response to history (reasoning_content stripped).
          this.pushAssistantMessage(message);
          break;
        }
      }

      // If we exhausted the turn budget while the model still had pending tool
      // calls, the conversation ends on 'tool' results with no assistant synthesis
      // (a half-executed plan). Surface it, then force one final tool-free turn so
      // the model reacts to the last tool batch and history ends on an assistant turn.
      if (turns >= MAX_TURNS_PER_INVOCATION) {
        const last = this.conversationHistory[this.conversationHistory.length - 1];
        if (last?.role === 'tool') {
          logger.error('Coordinator hit max turns mid-plan — forcing final synthesis', {
            eventType: triggeringEvent?.type,
          });
          metrics.increment('coordinator_max_turns_truncated');
          try {
            await this.rateLimiter.waitIfNeeded();
            const final = await this.circuitBreaker.execute(async () =>
              this.client.chat.completions.create({
                model: this.model,
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.conversationHistory],
                tool_choice: 'none',
                max_tokens: 1024,
              }),
            );
            const fm = final?.choices?.[0]?.message;
            if (fm) this.pushAssistantMessage(fm);
          } catch (err) {
            logger.error('Final synthesis turn failed', { error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          logger.warn('Coordinator hit max turns limit');
        }
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
      notifyChat: this.chatNotifier,
    };
  }
}
