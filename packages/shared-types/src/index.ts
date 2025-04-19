/**
 * Core Data Structures for Aetherius Project
 */

// Based on Section 4 of the specification

/**
 * Represents a task assigned to an agent or group of agents.
 */
export interface TaskObject {
  type: TaskType;
  details: TaskDetails;
}

export type TaskType =
  | "Gather"
  | "Craft"
  | "Smelt"
  | "PlaceBlock"
  | "Guard"
  | "Attack"
  | "Explore"
  | "Build"
  | "Follow"
  | "Transport"
  | "ManageContainer"
  | "NavigateTo";

// Using a union type for details based on the task type
export type TaskDetails =
  | GatherDetails
  | CraftDetails
  | SmeltDetails
  | PlaceBlockDetails
  | GuardDetails
  | AttackDetails
  | ExploreDetails
  | BuildDetails
  | FollowDetails
  | TransportDetails
  | ManageContainerDetails
  | NavigateToDetails;

// --- Specific Task Detail Interfaces ---

export interface Coordinates {
  x: number;
  y: number;
  z: number;
}

export interface GatherDetails {
  resource: string; // e.g., "minecraft:iron_ore"
  quantity: number;
  targetAreaCoords?: Coordinates; // Optional area hint
}

export interface CraftDetails {
  item: string; // e.g., "minecraft:crafting_table"
  quantity?: number; // Default: 1
  recipe?: any; // Optional: Specific recipe if ambiguous
}

export interface SmeltDetails {
  item: string; // Item to smelt
  fuel?: string; // Optional: Specific fuel item
  quantity: number;
}

export interface PlaceBlockDetails {
  item: string; // Block item to place
  destination: Coordinates;
  // Additional options like facing, etc., could be added
}

export interface GuardDetails {
  target?: { entityId: string } | { location: Coordinates }; // Entity or location to guard
  radius: number; // Guard radius
}

export interface AttackDetails {
  targetEntityId: string; // UUID or username
  targetType?: string; // Optional: e.g., "minecraft:zombie"
}

export interface ExploreDetails {
  area?: { center: Coordinates; radius: number }; // Optional: Define exploration area
  // Other parameters like duration, specific goals (find cave) could be added
}

export interface BuildDetails {
  structure: string; // Identifier for the structure type/schematic
  location: Coordinates; // Anchor point for building
  materials?: { [item: string]: number }; // Optional: Required materials list
}

export interface FollowDetails {
  targetEntityId: string; // UUID or username
  maxDistance?: number; // Optional: Max follow distance
}

export interface TransportDetails {
  item: string;
  quantity: number;
  sourceContainer?: Coordinates; // Optional: Source chest location
  destinationContainer: Coordinates; // Destination chest location
}

export interface ManageContainerDetails {
  action: "deposit" | "withdraw" | "list";
  containerCoords: Coordinates;
  items?: { item: string; quantity: number }[]; // Items for deposit/withdraw
}

export interface NavigateToDetails {
  targetCoords: Coordinates;
  tolerance?: number; // Optional: Allowed distance from target
}


// --- Agent Event ---

/**
 * Represents an event reported by an agent.
 */
export interface AgentEvent {
  agentId: string;
  taskId?: string; // Optional: Task this event relates to
  eventType: AgentEventType;
  timestamp: string; // ISO8601 format
  details: AgentEventDetails;
  destination: string; // squadLeaderId or "orchestrator" or "world_state_service"
}

export type AgentEventType =
  | "taskComplete"
  | "taskFailed"
  | "taskProgress" // Added for more granular updates
  | "detectedThreat"
  | "foundResource"
  | "foundPOI" // Added for Point of Interest reporting
  | "tookDamage"
  | "inventoryUpdate" // More generic than inventoryFull
  | "statusUpdate" // Generic status change
  | "taskRejected"; // If agent cannot perform task

export type AgentEventDetails =
  | TaskCompleteDetails
  | TaskFailedDetails
  | TaskProgressDetails
  | DetectedThreatDetails
  | FoundResourceDetails
  | FoundPOIDetails
  | TookDamageDetails
  | InventoryUpdateDetails
  | StatusUpdateDetails
  | TaskRejectedDetails;

// --- Specific Event Detail Interfaces ---

export interface TaskCompleteDetails {
  result?: any; // Optional: Task-specific results (e.g., items gathered)
}

export interface TaskFailedDetails {
  reason: string;
  error?: any; // Optional: Underlying error object/details
}

export interface TaskProgressDetails {
    progress: number; // e.g., 0.7 for 70%
    message?: string; // Optional description
}

export interface DetectedThreatDetails {
  threats: {
    type: string; // e.g., "minecraft:skeleton"
    entityId: string; // UUID
    location: Coordinates;
  }[];
}

export interface FoundResourceDetails {
  resourceType: string; // e.g., "minecraft:diamond_ore"
  quantityEstimate?: number | string; // e.g., 3 or "Small Vein"
  location: Coordinates;
}

export interface FoundPOIDetails {
    poiType: string; // e.g., "CaveEntrance", "Village", "Spawner"
    location: Coordinates;
    name?: string; // Optional name
    details?: object; // Type-specific extra info
}

export interface TookDamageDetails {
  damage: number;
  source?: string; // Optional: Source of damage (e.g., entityId, "fall")
  newHealth: number;
}

export interface InventoryUpdateDetails {
  added?: { item: string; quantity: number }[];
  removed?: { item: string; quantity: number }[];
  inventoryFull?: boolean;
  // Could include full inventory snapshot if needed, but likely too large often
}

export interface StatusUpdateDetails {
    status: string; // e.g., "Idle", "Pathfinding", "Mining"
    message?: string;
}

export interface TaskRejectedDetails {
    reason: string; // e.g., "Missing materials", "Invalid target"
}


// --- Agent Status Update (Periodic) ---

/**
 * Represents a periodic status update from an agent, distinct from events.
 * Used for Squad Leader context building.
 */
export interface AgentStatusSnapshot {
  agentId: string;
  timestamp: string; // ISO8601 format
  status: {
    health: number;
    hunger: number;
    saturation?: number; // Often relevant with hunger
    position: Coordinates;
    velocity?: Coordinates; // Optional, but useful
    yaw?: number; // Optional
    pitch?: number; // Optional
    onGround?: boolean; // Optional
    currentTaskDescription?: string; // High-level description from TEM
    currentTaskType?: TaskType; // Optional: Type of current task
    currentTaskId?: string; // Optional: ID of current task
    // Key inventory items (keep this concise for LLM context)
    keyInventory: { name: string; count: number }[];
    // Recent significant events (limited list for context)
    recentEvents?: string[]; // e.g., ["Took 5 damage", "Detected Skeleton"]
  };
  destination: string; // squadLeaderId or "orchestrator"
}

// --- WebSocket Message Structure ---

/**
 * Generic structure for WebSocket messages between services.
 */
export interface WebSocketMessage<T = any> {
    type: string; // e.g., "squadLeader::init", "agent::event::taskComplete"
    payload: T;
    senderId?: string; // Optional: ID of the sending service/instance
    timestamp?: string; // Optional: ISO8601
}

// --- World State Service API Payloads ---

export interface WorldStateReport_POI {
    reporterAgentId: string;
    timestamp: string; // ISO8601
    dataType: "poi";
    data: {
        type: string; // e.g., "CaveEntrance", "VillageChurch", "Spawner", "EndPortalFrame"
        name?: string; // Optional user-friendly name
        coords: Coordinates;
        biome?: string; // Optional
        details?: object; // Type-specific info
    };
}

export interface WorldStateReport_ResourceNode {
    reporterAgentId: string;
    timestamp: string; // ISO8601
    dataType: "resourceNode";
    data: {
        resourceType: string; // e.g., "minecraft:iron_ore", "minecraft:oak_log"
        coords: Coordinates; // Coord of first block found
        quantityEstimate?: string | number; // e.g., "Small", "Medium", "Large", "Single", or a number
        depleted?: boolean;
    };
}

export interface WorldStateReport_Infrastructure {
    reporterAgentId: string;
    timestamp: string; // ISO8601
    dataType: "infrastructure";
    data: {
        type: string; // e.g., "Base", "Farm", "StorageDepot"
        name: string;
        coords: Coordinates;
        features?: string[];
    };
}

export type WorldStateReportPayload =
    | WorldStateReport_POI
    | WorldStateReport_ResourceNode
    | WorldStateReport_Infrastructure;

// --- Orchestrator Specific ---
export interface AgentInfo {
    agentId: string;
    bsmAddress: string; // WebSocket address of the BSM managing this agent
    status: 'idle' | 'busy' | 'unknown';
    currentTaskType?: TaskType;
    currentSquadId?: string;
    lastKnownLocation?: Coordinates;
}

export interface SquadInfo {
    squadId: string;
    missionDescription: string;
    status: string; // e.g., "Initializing", "Executing", "Completing"
    progress?: number; // 0.0 to 1.0
    assignedAgentIds: string[];
}

// --- Squad Leader Specific ---
export interface AgentCommandObject {
    agentId: string;
    taskId: string; // Unique ID for this specific command instance
    task: TaskObject;
}