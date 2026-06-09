/**
 * Manually curated acquisition data for items that cannot be obtained
 * through crafting or smelting recipes alone.
 */

export interface MiningSource {
  block: string;
  toolRequirement: string | null; // minimum tool material: "wooden" | "stone" | "iron" | "diamond" | null (hand)
  yRange: [number, number];
  dimension: 'overworld' | 'nether' | 'end';
  drops?: string;        // if different from block name (e.g., "diamond" from "diamond_ore")
  silkTouchDrop?: string;
}

export interface MobDropSource {
  mob: string;
  chance: number;         // 0-1
  countRange: [number, number];
  dimension: 'overworld' | 'nether' | 'end';
  requiresPlayerKill?: boolean;
}

export interface LootSource {
  structure: string;
  dimension: 'overworld' | 'nether' | 'end';
  description: string;
}

// Keyed by the ITEM you obtain (not the block)
export const MINING_SOURCES: Record<string, MiningSource> = {
  // Overworld ores
  coal: { block: 'coal_ore', toolRequirement: 'wooden', yRange: [0, 256], dimension: 'overworld', drops: 'coal' },
  raw_iron: { block: 'iron_ore', toolRequirement: 'stone', yRange: [-64, 72], dimension: 'overworld', drops: 'raw_iron' },
  raw_gold: { block: 'gold_ore', toolRequirement: 'iron', yRange: [-64, 32], dimension: 'overworld', drops: 'raw_gold' },
  diamond: { block: 'diamond_ore', toolRequirement: 'iron', yRange: [-64, 16], dimension: 'overworld', drops: 'diamond' },
  redstone: { block: 'redstone_ore', toolRequirement: 'iron', yRange: [-64, 16], dimension: 'overworld', drops: 'redstone' },
  lapis_lazuli: { block: 'lapis_ore', toolRequirement: 'stone', yRange: [-64, 64], dimension: 'overworld', drops: 'lapis_lazuli' },
  emerald: { block: 'emerald_ore', toolRequirement: 'iron', yRange: [-16, 320], dimension: 'overworld', drops: 'emerald' },
  raw_copper: { block: 'copper_ore', toolRequirement: 'stone', yRange: [-16, 112], dimension: 'overworld', drops: 'raw_copper' },

  // Deepslate variants (same drops, different block)
  // Resolver checks both regular and deepslate variants

  // Nether ores
  ancient_debris: { block: 'ancient_debris', toolRequirement: 'diamond', yRange: [8, 22], dimension: 'nether', drops: 'ancient_debris' },
  nether_gold_ore: { block: 'nether_gold_ore', toolRequirement: 'wooden', yRange: [0, 128], dimension: 'nether', drops: 'gold_nugget' },
  nether_quartz: { block: 'nether_quartz_ore', toolRequirement: 'wooden', yRange: [0, 128], dimension: 'nether', drops: 'quartz' },

  // Basic blocks (mined directly)
  cobblestone: { block: 'stone', toolRequirement: 'wooden', yRange: [-64, 256], dimension: 'overworld', drops: 'cobblestone' },
  obsidian: { block: 'obsidian', toolRequirement: 'diamond', yRange: [-64, 256], dimension: 'overworld' },
  netherrack: { block: 'netherrack', toolRequirement: 'wooden', yRange: [0, 128], dimension: 'nether' },
  end_stone: { block: 'end_stone', toolRequirement: 'wooden', yRange: [0, 256], dimension: 'end' },
  sand: { block: 'sand', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  gravel: { block: 'gravel', toolRequirement: null, yRange: [-64, 256], dimension: 'overworld' },
  clay_ball: { block: 'clay', toolRequirement: null, yRange: [0, 256], dimension: 'overworld', drops: 'clay_ball' },

  // Wood (any tool, overworld surface)
  oak_log: { block: 'oak_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  birch_log: { block: 'birch_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  spruce_log: { block: 'spruce_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  jungle_log: { block: 'jungle_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  acacia_log: { block: 'acacia_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  dark_oak_log: { block: 'dark_oak_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  mangrove_log: { block: 'mangrove_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  cherry_log: { block: 'cherry_log', toolRequirement: null, yRange: [0, 256], dimension: 'overworld' },
  crimson_stem: { block: 'crimson_stem', toolRequirement: null, yRange: [0, 128], dimension: 'nether' },
  warped_stem: { block: 'warped_stem', toolRequirement: null, yRange: [0, 128], dimension: 'nether' },
};

// Keyed by the ITEM dropped
export const MOB_DROP_SOURCES: Record<string, MobDropSource[]> = {
  blaze_rod: [
    { mob: 'blaze', chance: 1.0, countRange: [0, 1], dimension: 'nether', requiresPlayerKill: true },
  ],
  ender_pearl: [
    { mob: 'enderman', chance: 1.0, countRange: [0, 1], dimension: 'overworld', requiresPlayerKill: true },
  ],
  gunpowder: [
    { mob: 'creeper', chance: 1.0, countRange: [0, 2], dimension: 'overworld', requiresPlayerKill: true },
  ],
  bone: [
    { mob: 'skeleton', chance: 1.0, countRange: [0, 2], dimension: 'overworld', requiresPlayerKill: true },
  ],
  string: [
    { mob: 'spider', chance: 1.0, countRange: [0, 2], dimension: 'overworld', requiresPlayerKill: true },
  ],
  rotten_flesh: [
    { mob: 'zombie', chance: 1.0, countRange: [0, 2], dimension: 'overworld', requiresPlayerKill: true },
  ],
  leather: [
    { mob: 'cow', chance: 1.0, countRange: [0, 2], dimension: 'overworld' },
  ],
  raw_beef: [
    { mob: 'cow', chance: 1.0, countRange: [1, 3], dimension: 'overworld' },
  ],
  raw_porkchop: [
    { mob: 'pig', chance: 1.0, countRange: [1, 3], dimension: 'overworld' },
  ],
  raw_chicken: [
    { mob: 'chicken', chance: 1.0, countRange: [1, 1], dimension: 'overworld' },
  ],
  feather: [
    { mob: 'chicken', chance: 1.0, countRange: [0, 2], dimension: 'overworld' },
  ],
  ghast_tear: [
    { mob: 'ghast', chance: 1.0, countRange: [0, 1], dimension: 'nether', requiresPlayerKill: true },
  ],
  wither_skeleton_skull: [
    { mob: 'wither_skeleton', chance: 0.025, countRange: [1, 1], dimension: 'nether', requiresPlayerKill: true },
  ],
  gold_nugget: [
    { mob: 'zombified_piglin', chance: 1.0, countRange: [0, 1], dimension: 'nether', requiresPlayerKill: true },
  ],
};

// Keyed by the ITEM obtainable
export const LOOT_SOURCES: Record<string, LootSource[]> = {
  netherite_upgrade_smithing_template: [
    { structure: 'bastion_remnant', dimension: 'nether', description: 'Found in bastion remnant treasure room chests' },
  ],
  saddle: [
    { structure: 'dungeon', dimension: 'overworld', description: 'Found in dungeon chests' },
    { structure: 'nether_fortress', dimension: 'nether', description: 'Found in nether fortress chests' },
  ],
  nether_wart: [
    { structure: 'nether_fortress', dimension: 'nether', description: 'Found growing in nether fortress stairwells' },
  ],
  // Enchanted books, name tags, etc. can be added as needed
};

/**
 * Generic "any log" alias — resolver checks if the recipe needs "planks" and
 * any log type will do. This maps planks back to the most common log.
 */
export const LOG_FOR_PLANKS: Record<string, string> = {
  oak_planks: 'oak_log',
  birch_planks: 'birch_log',
  spruce_planks: 'spruce_log',
  jungle_planks: 'jungle_log',
  acacia_planks: 'acacia_log',
  dark_oak_planks: 'dark_oak_log',
  crimson_planks: 'crimson_stem',
  warped_planks: 'warped_stem',
  mangrove_planks: 'mangrove_log',
  cherry_planks: 'cherry_log',
};
