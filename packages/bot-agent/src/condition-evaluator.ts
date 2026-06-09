/**
 * Evaluates CompletionConditions against live bot state.
 * Created per-task, checked every 250ms by TaskManager.
 */

import { Bot } from 'mineflayer';
import { CompletionCondition, Coordinates } from '@aetherius/shared-types';
import { StructureDetector } from './services/structure-detector';
import { Vec3 } from 'vec3';

export class ConditionEvaluator {
  private bot: Bot;
  private condition: CompletionCondition;
  private startTime: number;
  private structureDetector: StructureDetector | null;

  constructor(bot: Bot, condition: CompletionCondition, structureDetector?: StructureDetector) {
    this.bot = bot;
    this.condition = condition;
    this.startTime = Date.now();
    this.structureDetector = structureDetector ?? null;
  }

  /** Returns true when the completion condition is met. */
  evaluate(): boolean {
    if (!this.bot.entity) return false; // Bot not spawned yet

    switch (this.condition.type) {
      case 'inventory_has':
        return this.checkInventoryHas(this.condition.item, this.condition.count);

      case 'at_position':
        return this.checkAtPosition(this.condition.position, this.condition.radius);

      case 'time_elapsed':
        return this.checkTimeElapsed(this.condition.seconds);

      case 'entity_eliminated':
        return this.checkEntityEliminated(this.condition.entityType, this.condition.radius);

      case 'structure_found':
        return this.checkStructureFound(this.condition.structureType);

      case 'area_cleared':
        return this.checkAreaCleared(this.condition.radius);

      case 'indefinite':
        return false; // Never completes — coordinator must cancel

      default:
        return false;
    }
  }

  /** Get condition type for reporting */
  getConditionType(): string {
    return this.condition.type;
  }

  /** Get the raw condition for reporting */
  getCondition(): CompletionCondition {
    return this.condition;
  }

  private checkInventoryHas(item: string, count: number): boolean {
    const total = this.bot.inventory.items()
      .filter(i => i.name === item)
      .reduce((sum, i) => sum + i.count, 0);
    return total >= count;
  }

  private checkAtPosition(position: Coordinates, radius: number): boolean {
    const target = new Vec3(position.x, position.y, position.z);
    return this.bot.entity.position.distanceTo(target) <= radius;
  }

  private checkTimeElapsed(seconds: number): boolean {
    return (Date.now() - this.startTime) >= seconds * 1000;
  }

  private checkEntityEliminated(entityType: string, radius: number): boolean {
    const entity = this.bot.nearestEntity((e) =>
      e.name === entityType &&
      e.position.distanceTo(this.bot.entity.position) < radius
    );
    return entity === null;
  }

  private checkStructureFound(structureType: string): boolean {
    if (!this.structureDetector) return false;
    return this.structureDetector.hasDetectedStructure(structureType);
  }

  private checkAreaCleared(radius: number): boolean {
    const hostile = this.bot.nearestEntity((e) =>
      e.type === 'hostile' &&
      e.position.distanceTo(this.bot.entity.position) < radius
    );
    return hostile === null;
  }
}
