import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConditionEvaluator } from '../condition-evaluator';
import { CompletionCondition } from '@aetherius/shared-types';

// Minimal mock for Bot
function createMockBot(overrides: any = {}): any {
  return {
    entity: {
      position: {
        x: 100, y: 64, z: 200,
        distanceTo: (other: any) => {
          const dx = 100 - other.x;
          const dy = 64 - other.y;
          const dz = 200 - other.z;
          return Math.sqrt(dx * dx + dy * dy + dz * dz);
        },
      },
    },
    inventory: {
      items: () => overrides.inventoryItems ?? [],
    },
    nearestEntity: (filter: (e: any) => boolean) => {
      const entities = overrides.entities ?? [];
      return entities.find(filter) ?? null;
    },
    ...overrides,
  };
}

// Minimal mock for StructureDetector
function createMockStructureDetector(detected: string[] = []): any {
  const detectedSet = new Set(detected);
  return {
    hasDetectedStructure: (type: string) => {
      for (const key of detectedSet) {
        if (key.startsWith(type + ':') || key === type) return true;
      }
      return false;
    },
  };
}

describe('ConditionEvaluator', () => {
  describe('inventory_has', () => {
    it('returns true when agent has enough items', () => {
      const bot = createMockBot({
        inventoryItems: [
          { name: 'diamond', count: 5 },
          { name: 'iron_ingot', count: 10 },
        ],
      });
      const condition: CompletionCondition = { type: 'inventory_has', item: 'diamond', count: 3 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(true);
    });

    it('returns false when agent has fewer items than needed', () => {
      const bot = createMockBot({
        inventoryItems: [{ name: 'diamond', count: 2 }],
      });
      const condition: CompletionCondition = { type: 'inventory_has', item: 'diamond', count: 3 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });

    it('returns false when item not in inventory', () => {
      const bot = createMockBot({ inventoryItems: [] });
      const condition: CompletionCondition = { type: 'inventory_has', item: 'diamond', count: 1 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });

    it('sums across multiple stacks of the same item', () => {
      const bot = createMockBot({
        inventoryItems: [
          { name: 'diamond', count: 2 },
          { name: 'diamond', count: 3 },
        ],
      });
      const condition: CompletionCondition = { type: 'inventory_has', item: 'diamond', count: 5 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(true);
    });
  });

  describe('at_position', () => {
    it('returns true when within radius', () => {
      const bot = createMockBot(); // at (100, 64, 200)
      const condition: CompletionCondition = {
        type: 'at_position',
        position: { x: 102, y: 64, z: 200 },
        radius: 5,
      };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(true);
    });

    it('returns false when outside radius', () => {
      const bot = createMockBot(); // at (100, 64, 200)
      const condition: CompletionCondition = {
        type: 'at_position',
        position: { x: 200, y: 64, z: 200 },
        radius: 5,
      };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });
  });

  describe('time_elapsed', () => {
    it('returns false immediately', () => {
      const bot = createMockBot();
      const condition: CompletionCondition = { type: 'time_elapsed', seconds: 10 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });

    it('returns true after time has passed', () => {
      const bot = createMockBot();
      const condition: CompletionCondition = { type: 'time_elapsed', seconds: 0 };
      const evaluator = new ConditionEvaluator(bot, condition);
      // 0 seconds → should be true immediately (or within ms)
      expect(evaluator.evaluate()).toBe(true);
    });
  });

  describe('entity_eliminated', () => {
    it('returns true when no entities of type in radius', () => {
      const bot = createMockBot({ entities: [] });
      const condition: CompletionCondition = {
        type: 'entity_eliminated',
        entityType: 'zombie',
        radius: 16,
      };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(true);
    });

    it('returns false when entity of type exists in radius', () => {
      const bot = createMockBot({
        entities: [
          {
            name: 'zombie',
            position: {
              x: 105, y: 64, z: 200,
              distanceTo: () => 5,
            },
          },
        ],
      });
      const condition: CompletionCondition = {
        type: 'entity_eliminated',
        entityType: 'zombie',
        radius: 16,
      };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });
  });

  describe('structure_found', () => {
    it('returns true when structure has been detected', () => {
      const bot = createMockBot();
      const detector = createMockStructureDetector(['nether_fortress:5:10']);
      const condition: CompletionCondition = { type: 'structure_found', structureType: 'nether_fortress' };
      const evaluator = new ConditionEvaluator(bot, condition, detector);
      expect(evaluator.evaluate()).toBe(true);
    });

    it('returns false when structure not detected', () => {
      const bot = createMockBot();
      const detector = createMockStructureDetector([]);
      const condition: CompletionCondition = { type: 'structure_found', structureType: 'nether_fortress' };
      const evaluator = new ConditionEvaluator(bot, condition, detector);
      expect(evaluator.evaluate()).toBe(false);
    });

    it('returns false without structure detector', () => {
      const bot = createMockBot();
      const condition: CompletionCondition = { type: 'structure_found', structureType: 'village' };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });
  });

  describe('area_cleared', () => {
    it('returns true when no hostiles in radius', () => {
      const bot = createMockBot({ entities: [] });
      const condition: CompletionCondition = { type: 'area_cleared', radius: 32 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(true);
    });

    it('returns false when hostile in radius', () => {
      const bot = createMockBot({
        entities: [{
          type: 'hostile',
          position: { x: 105, y: 64, z: 200, distanceTo: () => 5 },
        }],
      });
      const condition: CompletionCondition = { type: 'area_cleared', radius: 32 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
    });
  });

  describe('indefinite', () => {
    it('always returns false', () => {
      const bot = createMockBot();
      const condition: CompletionCondition = { type: 'indefinite' };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.evaluate()).toBe(false);
      expect(evaluator.evaluate()).toBe(false);
      expect(evaluator.evaluate()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false when bot entity is null', () => {
      const bot = { entity: null, inventory: { items: () => [] }, nearestEntity: () => null };
      const condition: CompletionCondition = { type: 'inventory_has', item: 'diamond', count: 1 };
      const evaluator = new ConditionEvaluator(bot as any, condition);
      expect(evaluator.evaluate()).toBe(false);
    });

    it('exposes condition type via getConditionType()', () => {
      const bot = createMockBot();
      const condition: CompletionCondition = { type: 'area_cleared', radius: 16 };
      const evaluator = new ConditionEvaluator(bot, condition);
      expect(evaluator.getConditionType()).toBe('area_cleared');
    });
  });
});
