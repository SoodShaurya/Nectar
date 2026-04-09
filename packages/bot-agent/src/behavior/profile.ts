export interface AgentBehaviorProfile {
  // ===== SURVIVAL =====
  retreatHealthThreshold: number;
  foodReserveMinimum: number;
  hungerEatThreshold: number;

  // ===== HOSTILES =====
  mobEngagementPolicy: 'engage' | 'avoid' | 'auto';
  hostileDetectionRadius: number;
  creepAvoidanceRadius: number;

  // ===== PLAYERS =====
  playerResponsePolicy: 'engage' | 'avoid' | 'hide' | 'ignore';
  playerDetectionRadius: number;

  // ===== ENVIRONMENT =====
  allowNightSurface: boolean;
  allowLavaProximity: number;
  maxYDepth: number;

  // ===== RESOURCE MANAGEMENT =====
  inventoryDropPriority: string[];
  keepToolsMinimum: Record<string, number>;

  // ===== MOVEMENT =====
  maxExplorationRange: number;
  placeTorchesWhileMining: boolean;
}

export const DEFAULT_DROP_PRIORITY = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack',
  'andesite', 'diorite', 'granite', 'gravel', 'sand',
  'rotten_flesh', 'poisonous_potato', 'spider_eye',
];

export const BEHAVIOR_PRESETS: Record<string, AgentBehaviorProfile> = {
  cautious: {
    retreatHealthThreshold: 0.5,
    foodReserveMinimum: 4,
    hungerEatThreshold: 14,
    mobEngagementPolicy: 'avoid',
    hostileDetectionRadius: 24,
    creepAvoidanceRadius: 8,
    playerResponsePolicy: 'hide',
    playerDetectionRadius: 32,
    allowNightSurface: false,
    allowLavaProximity: 5,
    maxYDepth: 0,
    inventoryDropPriority: DEFAULT_DROP_PRIORITY,
    keepToolsMinimum: { pickaxe: 1, sword: 1 },
    maxExplorationRange: 1000,
    placeTorchesWhileMining: true,
  },
  balanced: {
    retreatHealthThreshold: 0.3,
    foodReserveMinimum: 2,
    hungerEatThreshold: 14,
    mobEngagementPolicy: 'auto',
    hostileDetectionRadius: 16,
    creepAvoidanceRadius: 8,
    playerResponsePolicy: 'avoid',
    playerDetectionRadius: 32,
    allowNightSurface: true,
    allowLavaProximity: 3,
    maxYDepth: -64,
    inventoryDropPriority: DEFAULT_DROP_PRIORITY,
    keepToolsMinimum: { pickaxe: 1 },
    maxExplorationRange: 1000,
    placeTorchesWhileMining: true,
  },
  aggressive: {
    retreatHealthThreshold: 0.15,
    foodReserveMinimum: 1,
    hungerEatThreshold: 10,
    mobEngagementPolicy: 'engage',
    hostileDetectionRadius: 16,
    creepAvoidanceRadius: 8,
    playerResponsePolicy: 'ignore',
    playerDetectionRadius: 32,
    allowNightSurface: true,
    allowLavaProximity: 1,
    maxYDepth: -64,
    inventoryDropPriority: DEFAULT_DROP_PRIORITY,
    keepToolsMinimum: {},
    maxExplorationRange: 2000,
    placeTorchesWhileMining: false,
  },
};

export function createDefaultProfile(): AgentBehaviorProfile {
  return { ...BEHAVIOR_PRESETS.balanced };
}
