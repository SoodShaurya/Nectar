/**
 * Coordinator LLM tool executor.
 *
 * Extracted from llm.ts. `executeTool(name, args, ctx)` performs the side
 * effects for each function call the model makes. The CoordinatorLLM class
 * builds the `ToolContext` and delegates to this function — behavior is
 * identical to the previous inline `executeTool` method.
 */

import { createLogger, metrics, CompletionCondition } from '@aetherius/shared-types';
import { AgentManager } from './agents';
import { WorldStateClient } from './world-state';
import { GoalBoard } from './goal-board';
import { resolveGoal } from './task-tree/resolver';
import { PROFILE_PRESETS } from './llm-prompt';

const logger = createLogger('coordinator:llm');

/** Dependencies the tool executor needs to perform its side effects. */
export interface ToolContext {
  agents: AgentManager;
  worldState: WorldStateClient;
  goalBoard: GoalBoard;
  mcVersion: string;
  /**
   * Optional sink that mirrors a coordinator chat reply to the web frontend.
   * Called for every messagePlayer so web users always see replies, even when
   * no in-game agent is connected to relay the message into Minecraft.
   */
  notifyChat?: (message: string) => void;
}

export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<any> {
  const { agents, worldState, goalBoard } = ctx;
  logger.debug('Executing tool', { name, args });

  switch (name) {
    case 'assignTask': {
      const { agentId, taskType, taskDetails, completionCondition, behaviorProfile } = args;

      // Apply profile if specified
      if (behaviorProfile) {
        const profile = PROFILE_PRESETS[behaviorProfile] ?? PROFILE_PRESETS.balanced;
        agents.sendProfile(agentId, profile);
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;

      // Parse completion condition if provided
      let condition: CompletionCondition | undefined;
      if (completionCondition && completionCondition.type) {
        condition = completionCondition as CompletionCondition;
      }

      const success = agents.sendCommand(agentId, taskId, { type: taskType, details: taskDetails }, condition);
      metrics.increment('tasks_assigned');
      return success
        ? { success: true, taskId, status: `Assigned ${taskType} to ${agentId}` }
        : { success: false, error: `Failed to assign to ${agentId} — check agent exists and BSM is connected` };
    }

    case 'cancelTask': {
      const success = agents.cancelTask(args.agentId);
      return { success, status: success ? 'Task cancelled' : 'Failed to cancel' };
    }

    case 'updateAgentProfile': {
      const profile = PROFILE_PRESETS[args.profile] ?? PROFILE_PRESETS.balanced;
      const success = agents.sendProfile(args.agentId, profile);
      return { success, status: success ? 'Profile updated' : 'Failed to update' };
    }

    case 'resolveTaskTree': {
      const inventories = agents.getInventories();
      const storage = await worldState.getStorageContents();
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
      const result = await worldState.query(args.query);
      return { success: true, result: result ?? 'No results' };
    }

    case 'createGoal': {
      const goal = await goalBoard.createGoal({
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
      const goal = await goalBoard.updateGoal(goalId, updates);
      return goal
        ? { success: true, status: 'Goal updated' }
        : { success: false, error: 'Goal not found' };
    }

    case 'completeGoal': {
      const goal = await goalBoard.completeGoal(args.goalId);
      return goal
        ? { success: true, status: 'Goal completed' }
        : { success: false, error: 'Goal not found' };
    }

    case 'pauseGoal': {
      const goal = await goalBoard.pauseGoal(args.goalId);
      return goal
        ? { success: true, status: 'Goal paused' }
        : { success: false, error: 'Goal not found' };
    }

    case 'resumeGoal': {
      const goal = await goalBoard.resumeGoal(args.goalId);
      return goal
        ? { success: true, status: 'Goal resumed' }
        : { success: false, error: 'Goal not found' };
    }

    case 'messagePlayer': {
      // Coordinator replies go to the WEB chat ONLY — they are NOT echoed into
      // in-game Minecraft chat. The bots should not spam server chat, and the
      // web frontend is the conversation surface. (mineflayer chat-send is also
      // unreliable on 1.21.11.)
      ctx.notifyChat?.(args.message);
      return { success: true, status: 'Message sent (web)' };
    }

    default:
      logger.warn('Unknown tool call', { name });
      return { success: false, error: `Unknown tool: ${name}` };
  }
}
