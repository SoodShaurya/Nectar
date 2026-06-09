import { describe, it, expect, beforeAll } from 'vitest';
import { resolveGoal, TaskNode } from '../task-tree/resolver';
import { initRecipes } from '../task-tree/recipes';

beforeAll(() => {
  initRecipes('1.21.1');
});

function nodeByItem(nodes: TaskNode[], item: string): TaskNode | undefined {
  return nodes.find(n => n.item === item);
}

function nodesByMethod(nodes: TaskNode[], method: string): TaskNode[] {
  return nodes.filter(n => n.method === method);
}

describe('Task Tree Resolver', () => {
  describe('basic resolution', () => {
    it('resolves a simple mineable item (oak_log) to a mine task', () => {
      const tasks = resolveGoal('oak_log', 4, {}, {});
      expect(tasks.length).toBeGreaterThan(0);
      const logTask = nodeByItem(tasks, 'oak_log');
      expect(logTask).toBeDefined();
      expect(logTask!.method).toBe('mine');
      expect(logTask!.count).toBe(4);
      expect(logTask!.dependsOn).toEqual([]);
    });

    it('returns empty list when item is already in inventory', () => {
      const tasks = resolveGoal('oak_log', 4, { agent1: { oak_log: 10 } }, {});
      expect(tasks.length).toBe(0);
    });

    it('returns empty list when item is in storage', () => {
      const tasks = resolveGoal('diamond', 3, {}, { 'chest_0,64,0': { diamond: 5 } });
      expect(tasks.length).toBe(0);
    });

    it('reduces needed count when partially available', () => {
      const tasks = resolveGoal('oak_log', 10, { agent1: { oak_log: 6 } }, {});
      const logTask = nodeByItem(tasks, 'oak_log');
      expect(logTask).toBeDefined();
      expect(logTask!.count).toBe(4); // 10 needed - 6 available
    });
  });

  describe('crafting resolution', () => {
    it('resolves stick crafting with plank dependency', () => {
      const tasks = resolveGoal('stick', 4, {}, {});
      expect(tasks.length).toBeGreaterThan(0);
      // Should have crafting task for sticks and a dependency for planks
      const stickTask = nodeByItem(tasks, 'stick');
      expect(stickTask).toBeDefined();
      expect(stickTask!.method).toBe('craft');
      expect(stickTask!.dependsOn.length).toBeGreaterThan(0);
    });

    it('resolves crafting_table from planks from logs', () => {
      const tasks = resolveGoal('crafting_table', 1, {}, {});
      expect(tasks.length).toBeGreaterThan(0);
      const ctTask = nodeByItem(tasks, 'crafting_table');
      expect(ctTask).toBeDefined();
      expect(ctTask!.method).toBe('craft');
    });
  });

  describe('smelting resolution', () => {
    it('resolves iron_ingot through smelting raw_iron', () => {
      const tasks = resolveGoal('iron_ingot', 3, {}, {});
      expect(tasks.length).toBeGreaterThan(0);

      const smeltTask = nodeByItem(tasks, 'iron_ingot');
      expect(smeltTask).toBeDefined();
      expect(smeltTask!.method).toBe('smelt');
      expect(smeltTask!.details.taskType).toBe('Smelt');

      // Should have dependency on raw_iron mining
      const mineTask = nodeByItem(tasks, 'raw_iron');
      expect(mineTask).toBeDefined();
      expect(mineTask!.method).toBe('mine');
    });

    it('includes coal fuel dependency for smelting', () => {
      const tasks = resolveGoal('iron_ingot', 3, {}, {});
      const coalTask = nodeByItem(tasks, 'coal');
      expect(coalTask).toBeDefined();
      expect(coalTask!.method).toBe('mine');
    });
  });

  describe('topological ordering', () => {
    it('places dependencies before dependents', () => {
      const tasks = resolveGoal('iron_ingot', 1, {}, {});
      const rawIronIdx = tasks.findIndex(t => t.item === 'raw_iron');
      const ironIngotIdx = tasks.findIndex(t => t.item === 'iron_ingot');
      // raw_iron should come before iron_ingot
      expect(rawIronIdx).toBeLessThan(ironIngotIdx);
    });

    it('places mining before crafting in a multi-step chain', () => {
      const tasks = resolveGoal('stick', 4, {}, {});
      const mineNodes = nodesByMethod(tasks, 'mine');
      const craftNodes = nodesByMethod(tasks, 'craft');
      if (mineNodes.length > 0 && craftNodes.length > 0) {
        const firstMine = tasks.indexOf(mineNodes[0]);
        const lastCraft = tasks.indexOf(craftNodes[craftNodes.length - 1]);
        expect(firstMine).toBeLessThan(lastCraft);
      }
    });
  });

  describe('inventory pruning', () => {
    it('prunes coal dependency when agent already has coal', () => {
      const tasks = resolveGoal('iron_ingot', 1, { agent1: { coal: 10 } }, {});
      const coalTask = nodeByItem(tasks, 'coal');
      // Coal should be pruned since we have enough
      expect(coalTask).toBeUndefined();
    });

    it('combines inventory across multiple agents', () => {
      const tasks = resolveGoal('diamond', 5, {
        agent1: { diamond: 2 },
        agent2: { diamond: 3 },
      }, {});
      expect(tasks.length).toBe(0); // 2+3 = 5, fully satisfied
    });

    it('combines agent inventory and storage', () => {
      const tasks = resolveGoal('diamond', 5, {
        agent1: { diamond: 2 },
      }, {
        'chest_0,64,0': { diamond: 3 },
      });
      expect(tasks.length).toBe(0); // 2+3 = 5
    });
  });

  describe('mob drops and loot', () => {
    it('resolves blaze_rod as kill_mob task', () => {
      const tasks = resolveGoal('blaze_rod', 2, {}, {});
      const blazeTask = nodeByItem(tasks, 'blaze_rod');
      expect(blazeTask).toBeDefined();
      expect(blazeTask!.method).toBe('kill_mob');
      expect(blazeTask!.details.taskDetails.target).toBe('blaze');
    });

    it('resolves ender_pearl as kill_mob task', () => {
      const tasks = resolveGoal('ender_pearl', 4, {}, {});
      const pearlTask = nodeByItem(tasks, 'ender_pearl');
      expect(pearlTask).toBeDefined();
      expect(pearlTask!.method).toBe('kill_mob');
      expect(pearlTask!.details.taskDetails.target).toBe('enderman');
    });
  });

  describe('mining with tool requirements', () => {
    it('resolves diamond mining with iron_pickaxe dependency', () => {
      const tasks = resolveGoal('diamond', 3, {}, {});
      const diamondTask = nodeByItem(tasks, 'diamond');
      expect(diamondTask).toBeDefined();
      expect(diamondTask!.method).toBe('mine');
      expect(diamondTask!.details.toolRequirement).toBe('iron');

      // Should have iron_pickaxe as dependency
      expect(diamondTask!.dependsOn.length).toBeGreaterThan(0);
      const pickaxeTask = tasks.find(t => t.item === 'iron_pickaxe');
      expect(pickaxeTask).toBeDefined();
    });

    it('skips tool dependency when agent already has the tool', () => {
      const tasks = resolveGoal('diamond', 3, { agent1: { iron_pickaxe: 1 } }, {});
      const pickaxeTask = tasks.find(t => t.item === 'iron_pickaxe');
      // Pickaxe should be pruned
      expect(pickaxeTask).toBeUndefined();
    });
  });

  describe('complex chains', () => {
    it('resolves netherite_scrap through smelting ancient_debris', () => {
      const tasks = resolveGoal('netherite_scrap', 4, {}, {});
      const scrapTask = nodeByItem(tasks, 'netherite_scrap');
      expect(scrapTask).toBeDefined();
      expect(scrapTask!.method).toBe('smelt');

      const debrisTask = nodeByItem(tasks, 'ancient_debris');
      expect(debrisTask).toBeDefined();
      expect(debrisTask!.method).toBe('mine');
      expect(debrisTask!.details.dimension).toBe('nether');
    });

    it('does not produce duplicate tasks for shared dependencies', () => {
      // Requesting 2 items that both need sticks — sticks should appear once
      const tasks = resolveGoal('wooden_pickaxe', 1, {}, {});
      const stickTasks = tasks.filter(t => t.item === 'stick');
      // May have 0 or 1, but never >1 for the same item in one resolution pass
      expect(stickTasks.length).toBeLessThanOrEqual(1);
    });
  });
});
