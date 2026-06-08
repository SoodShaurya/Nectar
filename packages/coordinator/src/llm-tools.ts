/**
 * Coordinator LLM function-declaration definitions (pure data).
 *
 * Extracted from llm.ts. The CoordinatorLLM class imports COORDINATOR_TOOLS and
 * passes it to the model as `tools: [{ functionDeclarations: COORDINATOR_TOOLS }]`.
 */

import { Type } from '@google/genai';

// --- Tool Definitions ---
export const COORDINATOR_TOOLS = [
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
