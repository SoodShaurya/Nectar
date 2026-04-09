/**
 * GoalBoard — HTTP client to the world-state-service goal endpoints.
 * Manages the coordinator's goal board with persistence in MongoDB.
 */

import { createLogger, metrics } from '@aetherius/shared-types';

const logger = createLogger('coordinator:goal-board');

export type GoalType = 'acquisition' | 'persistent' | 'construction' | 'exploration' | 'social' | 'composite';
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';
export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface Goal {
  goalId: string;
  type: GoalType;
  description: string;
  priority: GoalPriority;
  status: GoalStatus;
  assignedAgents: string[];
  state: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  parentGoal?: string;
}

export class GoalBoard {
  private apiAddress: string;
  // Local cache refreshed on each access
  private cache: Goal[] = [];
  private cacheTime = 0;
  private cacheTTL = 2000; // 2s cache

  constructor(apiAddress: string) {
    this.apiAddress = apiAddress;
  }

  // --- CRUD Operations ---

  async createGoal(params: {
    type: GoalType;
    description: string;
    priority?: GoalPriority;
    state?: Record<string, any>;
    parentGoal?: string;
  }): Promise<Goal | null> {
    const goalId = `goal-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;
    try {
      const response = await fetch(`${this.apiAddress}/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goalId,
          type: params.type,
          description: params.description,
          priority: params.priority ?? 'medium',
          state: params.state ?? {},
          parentGoal: params.parentGoal,
        }),
      });
      if (!response.ok) {
        logger.error('Failed to create goal', { status: response.status });
        return null;
      }
      const goal = await response.json() as any;
      metrics.increment('goals_created');
      logger.info(`Goal created: ${goalId} — "${params.description}"`);
      this.invalidateCache();
      return goal;
    } catch (error) {
      logger.error('Error creating goal', { error });
      return null;
    }
  }

  async updateGoal(goalId: string, updates: {
    description?: string;
    priority?: GoalPriority;
    status?: GoalStatus;
    assignedAgents?: string[];
    state?: Record<string, any>;
  }): Promise<Goal | null> {
    try {
      const response = await fetch(`${this.apiAddress}/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        logger.error('Failed to update goal', { goalId, status: response.status });
        return null;
      }
      this.invalidateCache();
      return await response.json() as any;
    } catch (error) {
      logger.error('Error updating goal', { goalId, error });
      return null;
    }
  }

  async completeGoal(goalId: string): Promise<Goal | null> {
    logger.info(`Completing goal: ${goalId}`);
    metrics.increment('goals_completed');
    return this.updateGoal(goalId, { status: 'completed' });
  }

  async pauseGoal(goalId: string): Promise<Goal | null> {
    logger.info(`Pausing goal: ${goalId}`);
    return this.updateGoal(goalId, { status: 'paused' });
  }

  async resumeGoal(goalId: string): Promise<Goal | null> {
    logger.info(`Resuming goal: ${goalId}`);
    return this.updateGoal(goalId, { status: 'active' });
  }

  async failGoal(goalId: string, reason?: string): Promise<Goal | null> {
    logger.info(`Failing goal: ${goalId}${reason ? ` — ${reason}` : ''}`);
    metrics.increment('goals_failed');
    return this.updateGoal(goalId, {
      status: 'failed',
      state: reason ? { failReason: reason } : undefined,
    });
  }

  // --- Queries ---

  async getActiveGoals(): Promise<Goal[]> {
    return this.fetchGoals({ status: 'active' });
  }

  async getAllGoals(): Promise<Goal[]> {
    return this.fetchGoals({});
  }

  async getGoalById(goalId: string): Promise<Goal | null> {
    try {
      const response = await fetch(`${this.apiAddress}/goals/${goalId}`);
      if (!response.ok) return null;
      return await response.json() as any;
    } catch (error) {
      logger.error('Error fetching goal', { goalId, error });
      return null;
    }
  }

  /**
   * Get a compact text summary of all active/paused goals for LLM context.
   */
  async getGoalSummary(): Promise<string> {
    const goals = await this.fetchGoals({});
    if (goals.length === 0) return 'No goals on the board.';

    const active = goals.filter(g => g.status === 'active');
    const paused = goals.filter(g => g.status === 'paused');

    const lines: string[] = [];
    if (active.length > 0) {
      lines.push(`**Active Goals (${active.length}):**`);
      for (const g of active) {
        const agents = g.assignedAgents.length > 0 ? g.assignedAgents.join(', ') : 'none';
        lines.push(`- [${g.priority}] ${g.goalId}: "${g.description}" (type: ${g.type}, agents: ${agents})`);
        if (Object.keys(g.state).length > 0) {
          lines.push(`  State: ${JSON.stringify(g.state)}`);
        }
      }
    }
    if (paused.length > 0) {
      lines.push(`**Paused Goals (${paused.length}):**`);
      for (const g of paused) {
        lines.push(`- [${g.priority}] ${g.goalId}: "${g.description}" (type: ${g.type})`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Get agents that are assigned to ONLY the specified goal (not shared with other active goals).
   * These agents should become idle when the goal is completed/cancelled.
   */
  async getExclusiveAgents(goalId: string): Promise<string[]> {
    const goals = await this.getActiveGoals();
    const targetGoal = goals.find(g => g.goalId === goalId);
    if (!targetGoal) return [];

    const otherGoalAgents = new Set<string>();
    for (const g of goals) {
      if (g.goalId !== goalId) {
        for (const a of g.assignedAgents) {
          otherGoalAgents.add(a);
        }
      }
    }

    return targetGoal.assignedAgents.filter(a => !otherGoalAgents.has(a));
  }

  // --- Internal ---

  private async fetchGoals(params: Record<string, string>): Promise<Goal[]> {
    // Use cache if fresh
    if (Date.now() - this.cacheTime < this.cacheTTL && this.cache.length > 0 && Object.keys(params).length === 0) {
      return this.cache;
    }

    try {
      const urlParams = new URLSearchParams(params);
      const response = await fetch(`${this.apiAddress}/goals?${urlParams.toString()}`);
      if (!response.ok) {
        logger.error('Failed to fetch goals', { status: response.status });
        return [];
      }
      const goals = await response.json() as any;
      if (Object.keys(params).length === 0) {
        this.cache = goals;
        this.cacheTime = Date.now();
      }
      return goals;
    } catch (error) {
      logger.error('Error fetching goals', { error });
      return [];
    }
  }

  private invalidateCache(): void {
    this.cacheTime = 0;
  }
}
