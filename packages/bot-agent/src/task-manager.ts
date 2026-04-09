import { Bot } from 'mineflayer';
import { createLogger, metrics, TaskObject, CompletionCondition } from '@aetherius/shared-types';
import { BaseModule } from './modules/base';
import { BSMClient } from './bsm';
import { ConditionEvaluator } from './condition-evaluator';
import { StructureDetector } from './services/structure-detector';

const logger = createLogger('bot-agent:tasks');

const CONDITION_CHECK_INTERVAL_MS = 250;

// Map task types to module names
const TASK_MODULE_MAP: Record<string, string> = {
  NavigateTo: 'navigation',
  Gather: 'gathering',
  Craft: 'crafting',
  Smelt: 'smelting',
  Attack: 'combat',
  Guard: 'combat',
  Explore: 'exploration',
  Build: 'building',
  PlaceBlock: 'building',
  ManageContainer: 'storage',
  Transport: 'transfer',
  Follow: 'navigation',
};

const VALID_TASK_TYPES = new Set(Object.keys(TASK_MODULE_MAP));

const REQUIRED_PARAMS: Record<string, string[]> = {
  NavigateTo: ['targetCoords'],
  Gather: ['target', 'quantity'],
  Attack: ['targetEntityId'],
  Craft: ['item', 'quantity'],
  Explore: ['goal'],
  Smelt: ['input', 'fuel', 'quantity'],
};

interface CurrentTask {
  id: string;
  type: string;
  module: BaseModule;
  conditionEvaluator: ConditionEvaluator | null;
  conditionCheckInterval: ReturnType<typeof setInterval> | null;
}

export class TaskManager {
  private modules: Map<string, BaseModule> = new Map();
  private bsm: BSMClient;
  private bot: Bot;
  private structureDetector: StructureDetector | null;
  private currentTask: CurrentTask | null = null;

  constructor(bsm: BSMClient, bot: Bot, structureDetector?: StructureDetector) {
    this.bsm = bsm;
    this.bot = bot;
    this.structureDetector = structureDetector ?? null;
  }

  registerModule(module: BaseModule): void {
    this.modules.set(module.name, module);
  }

  handleCommand(taskId: string, task: TaskObject, completionCondition?: CompletionCondition): void {
    metrics.increment('commands_received');
    metrics.increment(`command_${task.type}`);

    // Validate
    if (!this.validateCommand(task)) {
      this.bsm.reportEvent({
        eventType: 'taskRejected',
        taskId,
        details: { reason: 'Validation failed' },
      });
      return;
    }

    // Find module
    const moduleName = TASK_MODULE_MAP[task.type];
    if (!moduleName) {
      this.bsm.reportEvent({
        eventType: 'taskFailed',
        taskId,
        details: { reason: `No module for task type: ${task.type}` },
      });
      return;
    }

    const module = this.modules.get(moduleName);
    if (!module) {
      this.bsm.reportEvent({
        eventType: 'taskFailed',
        taskId,
        details: { reason: `Module not registered: ${moduleName}` },
      });
      return;
    }

    // Deactivate current task (cleanup intervals + listeners)
    this.clearCurrentTask('Interrupted by new task');

    // Wire up module events
    module.removeAllListeners();
    module.on('complete', (data) => {
      logger.info(`Task ${taskId} (${task.type}) completed by module`);
      metrics.increment('tasks_completed');
      this.clearConditionCheck();
      this.bsm.reportEvent({
        eventType: 'taskComplete',
        taskId,
        details: { result: data, reason: 'module_complete' },
      });
      this.currentTask = null;
    });

    module.on('failed', (data) => {
      logger.error(`Task ${taskId} (${task.type}) failed: ${data.reason}`);
      metrics.increment('tasks_failed');
      this.clearConditionCheck();
      this.bsm.reportEvent({
        eventType: 'taskFailed',
        taskId,
        details: data,
      });
      this.currentTask = null;
    });

    module.on('alert', (data) => {
      this.bsm.reportEvent({
        eventType: 'behaviorAlert',
        taskId,
        details: data,
      });
    });

    // Set up current task
    this.currentTask = {
      id: taskId,
      type: task.type,
      module,
      conditionEvaluator: null,
      conditionCheckInterval: null,
    };

    // Activate module
    logger.info(`Activating ${moduleName} for task ${taskId} (${task.type})`);
    const params = this.mapTaskToParams(task);
    module.activate(params);

    // Set up completion condition check (if provided and not indefinite)
    if (completionCondition && completionCondition.type !== 'indefinite') {
      const evaluator = new ConditionEvaluator(this.bot, completionCondition, this.structureDetector ?? undefined);
      this.currentTask.conditionEvaluator = evaluator;

      this.currentTask.conditionCheckInterval = setInterval(() => {
        if (evaluator.evaluate()) {
          logger.info(`Completion condition met for task ${taskId}: ${completionCondition.type}`);
          metrics.increment('condition_completions');
          this.clearConditionCheck();

          // Deactivate the module (it may still be running)
          module.removeAllListeners();
          module.deactivate();

          this.bsm.reportEvent({
            eventType: 'taskComplete',
            taskId,
            details: { reason: 'condition_met', condition: completionCondition },
          });
          this.currentTask = null;
        }
      }, CONDITION_CHECK_INTERVAL_MS);
    }
  }

  /** Cancel the current task. Called when coordinator sends cancelTask. */
  cancelCurrentTask(taskId?: string): void {
    if (!this.currentTask) return;
    if (taskId && this.currentTask.id !== taskId) return;

    logger.info(`Cancelling task ${this.currentTask.id} (${this.currentTask.type})`);
    this.clearCurrentTask('Cancelled by coordinator');
  }

  getCurrentModule(): BaseModule | null {
    return this.currentTask?.module ?? null;
  }

  getCurrentTaskDescription(): string | undefined {
    return this.currentTask ? `${this.currentTask.type}` : undefined;
  }

  // --- Internal ---

  private clearCurrentTask(reason: string): void {
    if (!this.currentTask) return;

    this.clearConditionCheck();
    this.currentTask.module.removeAllListeners();
    this.currentTask.module.deactivate();
    this.bsm.reportEvent({
      eventType: 'taskFailed',
      taskId: this.currentTask.id,
      details: { reason },
    });
    this.currentTask = null;
  }

  private clearConditionCheck(): void {
    if (this.currentTask?.conditionCheckInterval) {
      clearInterval(this.currentTask.conditionCheckInterval);
      this.currentTask.conditionCheckInterval = null;
    }
  }

  private validateCommand(task: TaskObject): boolean {
    if (!task || !task.type || !task.details) {
      logger.warn('Rejected command: missing type or details');
      return false;
    }
    if (!VALID_TASK_TYPES.has(task.type)) {
      logger.warn(`Rejected command: unknown task type "${task.type}"`);
      return false;
    }
    const required = REQUIRED_PARAMS[task.type];
    if (required) {
      for (const param of required) {
        if ((task.details as any)[param] === undefined || (task.details as any)[param] === null) {
          logger.warn(`Rejected ${task.type}: missing param "${param}"`);
          return false;
        }
      }
    }
    return true;
  }

  private mapTaskToParams(task: TaskObject): any {
    const d = task.details as any;

    switch (task.type) {
      case 'NavigateTo':
        return { destination: d.targetCoords };
      case 'Gather':
        return { targetType: d.targetType ?? 'block', target: d.resource ?? d.target, quantity: d.quantity, maxY: d.maxY, searchRadius: d.searchRadius };
      case 'Craft':
        return { item: d.item, quantity: d.quantity ?? 1 };
      case 'Smelt':
        return { input: d.input ?? d.item, fuel: d.fuel ?? 'coal', quantity: d.quantity };
      case 'Attack':
        return { mode: 'aggressive', engagementPolicy: 'engage', targetPriority: ['specific'], specificTargets: [d.targetEntityId], retreatThreshold: 0.15, reportPlayers: true };
      case 'Guard':
        return {
          mode: d.mode ?? 'defensive',
          engagementPolicy: d.engagementPolicy ?? 'engage',
          targetPriority: d.targetPriority ?? ['hostile'],
          retreatThreshold: d.retreatThreshold ?? 0.3,
          reportPlayers: d.reportPlayers ?? true,
          patrolArea: d.patrolArea,
        };
      case 'Explore':
        return d;
      case 'Build':
        return { schematic: d.structure, origin: d.location, blocks: d.blocks };
      case 'PlaceBlock':
        return { blocks: [{ pos: d.destination, block: d.item }] };
      case 'ManageContainer':
        return { action: d.action, position: d.containerCoords, items: d.items, searchRadius: d.searchRadius };
      case 'Transport':
        return { targetAgent: d.targetAgent, items: [{ item: d.item, count: d.quantity }], targetPosition: d.destinationContainer };
      default:
        return d;
    }
  }
}
