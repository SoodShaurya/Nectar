/**
 * Coordinator LLM tool definitions (pure data), in OpenAI tool-calling format.
 *
 * The CoordinatorLLM class imports COORDINATOR_TOOLS and passes it to the model
 * as `tools: COORDINATOR_TOOLS` on chat.completions.create. Each entry follows
 * the OpenAI shape: { type: 'function', function: { name, description, parameters } }
 * where `parameters` is a JSON Schema object.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';

// --- Tool Definitions ---
export const COORDINATOR_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'assignTask',
      description: 'Assign a module task to an idle agent with optional completion condition and behavior profile.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID of the idle agent.' },
          taskType: { type: 'string', description: 'Task type: Gather, Craft, Smelt, NavigateTo, Explore, Guard, Attack, Build, PlaceBlock, ManageContainer, Transport.' },
          taskDetails: { type: 'object', description: 'Module-specific parameters.', properties: {} },
          completionCondition: { type: 'object', description: 'Optional completion condition. Omit for module-default completion.', properties: {} },
          behaviorProfile: { type: 'string', description: 'Optional profile preset: "cautious", "balanced", "aggressive".' },
        },
        required: ['agentId', 'taskType', 'taskDetails'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelTask',
      description: 'Cancel an agent\'s current task. Agent becomes idle.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent to cancel.' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'updateAgentProfile',
      description: 'Update an agent\'s behavior profile without changing its current task.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent to update.' },
          profile: { type: 'string', description: 'Profile preset: "cautious", "balanced", "aggressive".' },
        },
        required: ['agentId', 'profile'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolveTaskTree',
      description: 'Resolve an item\'s crafting dependency tree. Returns ordered task list pruned against current inventories. Use for acquisition goals ONLY.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Item name (e.g., "diamond_pickaxe").' },
          count: { type: 'number', description: 'How many to obtain.' },
        },
        required: ['item', 'count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queryWorldState',
      description: 'Query the world state database for POIs, resources, storage contents, or infrastructure.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'object', description: 'Query params: {type: "poi"|"resourceNode"|"infrastructure", filter: {...}, options: {limit: N}}', properties: {} },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createGoal',
      description: 'Create a new goal on the goal board.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What the goal is (e.g., "Obtain full netherite armor").' },
          type: { type: 'string', description: 'Goal type: acquisition, persistent, construction, exploration, social, composite.' },
          priority: { type: 'string', description: 'Priority: critical, high, medium, low.' },
        },
        required: ['description', 'type', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'updateGoal',
      description: 'Update a goal\'s priority, assignedAgents, or state.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal ID to update.' },
          priority: { type: 'string', description: 'New priority.' },
          assignedAgents: { type: 'array', description: 'Agent IDs assigned to this goal.', items: { type: 'string' } },
          state: { type: 'object', description: 'Goal-specific state update.', properties: {} },
        },
        required: ['goalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'completeGoal',
      description: 'Mark a goal as completed.',
      parameters: {
        type: 'object',
        properties: { goalId: { type: 'string' } },
        required: ['goalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pauseGoal',
      description: 'Pause a goal. Agents on only this goal become idle.',
      parameters: {
        type: 'object',
        properties: { goalId: { type: 'string' } },
        required: ['goalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resumeGoal',
      description: 'Resume a paused goal.',
      parameters: {
        type: 'object',
        properties: { goalId: { type: 'string' } },
        required: ['goalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'messagePlayer',
      description: 'Send a chat message to the Minecraft server. The message appears in-game.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The chat message to send.' },
        },
        required: ['message'],
      },
    },
  },
];
