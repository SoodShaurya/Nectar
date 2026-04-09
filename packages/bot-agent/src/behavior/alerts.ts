import { Coordinates } from '@aetherius/shared-types';

export type BehaviorAlertType =
  | 'health_low'
  | 'food_reserve_low'
  | 'player_detected'
  | 'agent_death'
  | 'night_shelter'
  | 'inventory_full'
  | 'tool_low'
  | 'out_of_range';

export interface BehaviorAlert {
  agentId: string;
  type: BehaviorAlertType;
  details: Record<string, any>;
  activeModule: string | null;
  moduleState: 'paused' | 'cancelled' | 'unaffected';
  timestamp: number;
}

export interface HealthLowDetails {
  health: number;
  threshold: number;
  retreatingTo: Coordinates | null;
}

export interface FoodReserveLowDetails {
  currentFood: number;
  threshold: number;
}

export interface PlayerDetectedDetails {
  playerName: string;
  position: Coordinates;
  distance: number;
  autonomousResponse: 'engage' | 'avoid' | 'hide' | 'ignore';
}

export interface AgentDeathDetails {
  deathPos: Coordinates;
  respawnPos: Coordinates | null;
}

export interface NightShelterDetails {
  shelterLocation: Coordinates | null;
  estimatedResume: number;
}

export interface InventoryFullDetails {
  itemCounts: Record<string, number>;
  dropPriorityAvailable: boolean;
}

export interface ToolLowDetails {
  toolType: string;
  currentCount: number;
  threshold: number;
}

export interface OutOfRangeDetails {
  targetPos: Coordinates;
  maxRange: number;
  currentDistance: number;
}
