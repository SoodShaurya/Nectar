/**
 * Task Tree Resolver
 *
 * Takes a goal item + count, recursively walks the dependency tree using
 * minecraft-data recipes + manual sources, prunes against current inventories
 * and storage, and outputs a topologically sorted flat task list.
 */

import { createLogger } from '@aetherius/shared-types';
import { getCraftingRecipe, getSmeltingRecipe } from './recipes';
import { MINING_SOURCES, MOB_DROP_SOURCES, LOOT_SOURCES, LOG_FOR_PLANKS } from './manual-sources';

const logger = createLogger('coordinator:task-tree');

export type TaskMethod = 'craft' | 'smelt' | 'mine' | 'kill_mob' | 'loot' | 'gather';

export interface TaskNode {
  id: string;
  item: string;
  count: number;
  method: TaskMethod;
  details: Record<string, any>;
  dependsOn: string[];
  satisfied: boolean;
}

let nextId = 0;
function generateId(): string {
  return `task-${++nextId}`;
}

/**
 * Resolve a goal item into a flat, ordered task list.
 *
 * @param item       The item to obtain (e.g., "diamond_pickaxe")
 * @param count      How many to obtain
 * @param inventories Agent inventories: { agentId: { itemName: count } }
 * @param storage    Known storage contents: { locationKey: { itemName: count } }
 * @returns Topologically sorted task list (dependencies first)
 */
export function resolveGoal(
  item: string,
  count: number,
  inventories: Record<string, Record<string, number>>,
  storage: Record<string, Record<string, number>>,
): TaskNode[] {
  // Reset ID counter for deterministic IDs per resolve call
  nextId = 0;

  // Aggregate all available items (across all agents + all storage)
  const available: Record<string, number> = {};
  for (const inv of Object.values(inventories)) {
    for (const [name, qty] of Object.entries(inv)) {
      available[name] = (available[name] ?? 0) + qty;
    }
  }
  for (const store of Object.values(storage)) {
    for (const [name, qty] of Object.entries(store)) {
      available[name] = (available[name] ?? 0) + qty;
    }
  }

  const allNodes: TaskNode[] = [];
  const visiting = new Set<string>(); // cycle detection

  resolveItem(item, count, available, allNodes, visiting);

  // Filter out satisfied nodes
  const unsatisfied = allNodes.filter(n => !n.satisfied);

  // Topological sort (Kahn's algorithm)
  return topologicalSort(unsatisfied);
}

function resolveItem(
  item: string,
  count: number,
  available: Record<string, number>,
  allNodes: TaskNode[],
  visiting: Set<string>,
): string | null {
  // Cycle detection
  if (visiting.has(item)) {
    logger.warn(`Cycle detected for item: ${item}, treating as raw gathering task`);
    return addGatherNode(item, count, allNodes);
  }
  visiting.add(item);

  // Check if already available
  const have = available[item] ?? 0;
  if (have >= count) {
    // Consume from available
    available[item] = have - count;
    visiting.delete(item);
    return null; // No task needed
  }

  // Partially available — reduce needed count
  const needed = count - have;
  if (have > 0) {
    available[item] = 0; // Consume all we have
  }

  let nodeId: string | null = null;

  // Priority order: manual sources (mining/mob/loot) → smelting → crafting
  // This prevents raw materials like diamond from resolving through the
  // diamond_block decomposition recipe instead of mining.

  // 1. Try mining source (highest priority for raw materials)
  const miningSource = MINING_SOURCES[item];
  if (miningSource) {
    const depIds: string[] = [];
    if (miningSource.toolRequirement) {
      const toolItem = `${miningSource.toolRequirement}_pickaxe`;
      const toolDepId = resolveItem(toolItem, 1, available, allNodes, visiting);
      if (toolDepId) depIds.push(toolDepId);
    }

    nodeId = generateId();
    allNodes.push({
      id: nodeId,
      item,
      count: needed,
      method: 'mine',
      details: {
        taskType: 'Gather',
        taskDetails: {
          targetType: 'block',
          target: miningSource.drops ?? miningSource.block,
          quantity: needed,
          maxY: miningSource.yRange[1],
        },
        block: miningSource.block,
        dimension: miningSource.dimension,
        yRange: miningSource.yRange,
        toolRequirement: miningSource.toolRequirement,
      },
      dependsOn: depIds,
      satisfied: false,
    });

    visiting.delete(item);
    return nodeId;
  }

  // 2. Try mob drop source
  const mobSources = MOB_DROP_SOURCES[item];
  if (mobSources && mobSources.length > 0) {
    const source = mobSources[0];
    const killsNeeded = Math.ceil(needed / Math.max(1, source.countRange[1]));

    nodeId = generateId();
    allNodes.push({
      id: nodeId,
      item,
      count: needed,
      method: 'kill_mob',
      details: {
        taskType: 'Gather',
        taskDetails: {
          targetType: 'entity',
          target: source.mob,
          quantity: killsNeeded,
        },
        mob: source.mob,
        dimension: source.dimension,
      },
      dependsOn: [],
      satisfied: false,
    });

    visiting.delete(item);
    return nodeId;
  }

  // 3. Try loot source
  const lootSources = LOOT_SOURCES[item];
  if (lootSources && lootSources.length > 0) {
    const source = lootSources[0];

    nodeId = generateId();
    allNodes.push({
      id: nodeId,
      item,
      count: needed,
      method: 'loot',
      details: {
        taskType: 'Explore',
        taskDetails: {
          goal: 'find_structure',
          structureType: source.structure,
          dimension: source.dimension,
        },
        structure: source.structure,
        dimension: source.dimension,
      },
      dependsOn: [],
      satisfied: false,
    });

    visiting.delete(item);
    return nodeId;
  }

  // 4. Try smelting recipe (before crafting — iron_ingot should smelt, not craft from nuggets)
  const smeltRecipe = getSmeltingRecipe(item);
  if (smeltRecipe) {
    const smeltsNeeded = Math.ceil(needed / smeltRecipe.outputCount);
    const depIds: string[] = [];

    // Resolve input
    const inputDepId = resolveItem(smeltRecipe.input, smeltsNeeded, available, allNodes, visiting);
    if (inputDepId) depIds.push(inputDepId);

    // Resolve fuel (assume coal, 1 coal = 8 smelts)
    const fuelNeeded = Math.ceil(smeltsNeeded / 8);
    const fuelDepId = resolveItem('coal', fuelNeeded, available, allNodes, visiting);
    if (fuelDepId) depIds.push(fuelDepId);

    nodeId = generateId();
    allNodes.push({
      id: nodeId,
      item,
      count: smeltsNeeded,
      method: 'smelt',
      details: {
        taskType: 'Smelt',
        taskDetails: { input: smeltRecipe.input, fuel: 'coal', quantity: smeltsNeeded },
      },
      dependsOn: depIds,
      satisfied: false,
    });

    visiting.delete(item);
    return nodeId;
  }

  // 5. Try crafting recipe (lowest priority — avoids decomposition recipes like diamond_block → diamond)
  const craftRecipe = getCraftingRecipe(item);
  if (craftRecipe) {
    const craftsNeeded = Math.ceil(needed / craftRecipe.outputCount);
    const depIds: string[] = [];

    for (const ingredient of craftRecipe.ingredients) {
      const ingNeeded = ingredient.count * craftsNeeded;
      const depId = resolveItem(ingredient.item, ingNeeded, available, allNodes, visiting);
      if (depId) depIds.push(depId);
    }

    nodeId = generateId();
    allNodes.push({
      id: nodeId,
      item,
      count: craftsNeeded,
      method: 'craft',
      details: {
        taskType: 'Craft',
        taskDetails: { item, quantity: craftsNeeded },
        requiresTable: craftRecipe.requiresTable,
      },
      dependsOn: depIds,
      satisfied: false,
    });

    visiting.delete(item);
    return nodeId;
  }

  // 6. Check if this is a planks variant → resolve via corresponding log
  const logForPlanks = LOG_FOR_PLANKS[item];
  if (logForPlanks) {
    const depIds: string[] = [];
    // 1 log = 4 planks
    const logsNeeded = Math.ceil(needed / 4);
    const logDepId = resolveItem(logForPlanks, logsNeeded, available, allNodes, visiting);
    if (logDepId) depIds.push(logDepId);

    nodeId = generateId();
    allNodes.push({
      id: nodeId,
      item,
      count: needed,
      method: 'craft',
      details: {
        taskType: 'Craft',
        taskDetails: { item, quantity: Math.ceil(needed / 4) },
      },
      dependsOn: depIds,
      satisfied: false,
    });

    visiting.delete(item);
    return nodeId;
  }

  // 7. Fallback: generic gather task
  visiting.delete(item);
  return addGatherNode(item, needed, allNodes);
}

function addGatherNode(item: string, count: number, allNodes: TaskNode[]): string {
  const nodeId = generateId();
  allNodes.push({
    id: nodeId,
    item,
    count,
    method: 'gather',
    details: {
      taskType: 'Gather',
      taskDetails: { targetType: 'block', target: item, quantity: count },
    },
    dependsOn: [],
    satisfied: false,
  });
  return nodeId;
}

function topologicalSort(nodes: TaskNode[]): TaskNode[] {
  const nodeMap = new Map<string, TaskNode>();
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }

  // Build adjacency and in-degree
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (nodeIds.has(dep)) {
        adj.get(dep)!.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: TaskNode[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(nodeMap.get(current)!);

    for (const neighbor of adj.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // If some nodes weren't reached (cycle), append them anyway
  if (sorted.length < nodes.length) {
    const sortedIds = new Set(sorted.map(n => n.id));
    for (const node of nodes) {
      if (!sortedIds.has(node.id)) {
        sorted.push(node);
      }
    }
  }

  return sorted;
}
