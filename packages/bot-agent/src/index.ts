import mineflayer, { Bot } from '@aetherius/mineflayer-core'; // Import Bot type
import net from 'net';
import { AgentEvent, AgentStatusSnapshot, TaskObject, WebSocketMessage, TaskType, Coordinates } from '@aetherius/shared-types';
// Keep type/goal imports, but load plugins via require
import { goals } from '@aetherius/pathfinder';
const { GoalBlock } = goals;
import { Item } from 'prismarine-item'; // Import Item type for inventory methods
import { Recipe } from 'prismarine-recipe'; // Import Recipe type for crafting
import { Block } from 'prismarine-block'; // Import Block type

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || `agent-unknown-${Math.random().toString(36).substring(2, 8)}`;
const BSM_TCP_PORT = parseInt(process.env.BSM_TCP_PORT || '4001', 10);
const BSM_HOST = process.env.BSM_HOST || '127.0.0.1';
const MINECRAFT_HOST = process.env.MC_HOST || 'localhost';
const MINECRAFT_PORT = parseInt(process.env.MC_PORT || '25565', 10);
const MINECRAFT_VERSION = process.env.MC_VERSION || '1.20.1'; // Or fetch dynamically

console.log(`--- Bot Agent (${AGENT_ID}) ---`);
console.log(`Connecting to BSM at ${BSM_HOST}:${BSM_TCP_PORT}`);
console.log(`Connecting to Minecraft at ${MINECRAFT_HOST}:${MINECRAFT_PORT} (Version: ${MINECRAFT_VERSION})`);

// --- BSM Communication (Control Unit) ---
let bsmSocket: net.Socket | null = null;
let isRegisteredWithBSM = false;
let messageBuffer = ''; // Buffer for incoming TCP data
const recentEventSummaries: string[] = []; // Store recent event summaries
const MAX_RECENT_EVENTS = 5; // Max number of event summaries to keep
const KEY_ITEM_CATEGORIES = ['tool', 'weapon', 'armor', 'food', 'resource']; // Categories to include in inventory summary

function connectToBSM() {
    if (bsmSocket && !bsmSocket.destroyed) {
        console.log('Already connected or connecting to BSM.');
        return;
    }

    bsmSocket = net.createConnection({ host: BSM_HOST, port: BSM_TCP_PORT }, () => {
        console.log('Connected to BSM TCP server.');
        // Register with BSM
        const registrationMessage = { type: 'register', payload: { agentId: AGENT_ID } };
        sendToBSM(registrationMessage);
        isRegisteredWithBSM = true; // Assume registration success for now
    });

    bsmSocket.on('data', (data: Buffer) => {
        messageBuffer += data.toString();
        let boundary = messageBuffer.indexOf('\n');

        while (boundary !== -1) {
            const messageString = messageBuffer.substring(0, boundary);
            messageBuffer = messageBuffer.substring(boundary + 1);

            try {
                const message = JSON.parse(messageString);
                console.log(`Received message from BSM: ${message.type}`);

                if (message.type === 'command' && message.payload) {
                    handleIncomingCommand(message.payload.taskId, message.payload.task);
                } else {
                    console.warn(`Received unknown message type from BSM: ${message.type}`);
                }
            } catch (error) {
                console.error('Failed to parse BSM message:', error, `\nRaw data part: ${messageString}`);
            }
            boundary = messageBuffer.indexOf('\n'); // Check for next message in buffer
        }
    });

    bsmSocket.on('end', () => {
        console.log('Disconnected from BSM TCP server.');
        isRegisteredWithBSM = false;
        bsmSocket = null;
        // Implement reconnection logic
        console.log('Attempting to reconnect to BSM in 5 seconds...');
        setTimeout(connectToBSM, 5000);
    });

    bsmSocket.on('error', (err: Error) => {
        console.error('BSM TCP connection error:', err.message);
        isRegisteredWithBSM = false;
        bsmSocket?.destroy(); // Ensure socket is destroyed on error
        bsmSocket = null;
        // Implement reconnection logic
        if (!err.message.includes('ECONNREFUSED')) { // Avoid spamming logs if server is just down
             console.log('Attempting to reconnect to BSM in 5 seconds...');
             setTimeout(connectToBSM, 5000);
        } else {
             console.log('BSM connection refused. Will retry later.');
             setTimeout(connectToBSM, 15000); // Longer delay if refused
        }
    });
}

// --- Reporting Module ---
function sendToBSM(message: any): boolean {
    if (bsmSocket && !bsmSocket.destroyed && isRegisteredWithBSM) {
        try {
            bsmSocket.write(JSON.stringify(message) + '\n');
            return true;
        } catch (error) {
            console.error('Failed to send message to BSM:', error);
            return false;
        }
    } else {
        console.warn('Cannot send message: Not connected or registered with BSM.');
        return false;
    }
}

function reportEvent(event: Omit<AgentEvent, 'agentId' | 'timestamp' | 'destination'>): void {
    const fullEvent: AgentEvent = {
        ...event,
        agentId: AGENT_ID,
        timestamp: new Date().toISOString(),
        // Destination will be determined by BSM based on commander assignment
        // However, perception reports need specific destination
        destination: event.eventType === 'foundPOI' || event.eventType === 'foundResource'
            ? 'world_state_service'
            : 'commander' // Placeholder, BSM resolves this
    };
    const summary = `[${new Date().toLocaleTimeString()}] ${fullEvent.eventType}${fullEvent.taskId ? ` (Task: ${fullEvent.taskId})` : ''}${('details' in fullEvent && 'reason' in fullEvent.details) ? `: ${fullEvent.details.reason}` : ''}`;
    recentEventSummaries.push(summary);
    if (recentEventSummaries.length > MAX_RECENT_EVENTS) {
        recentEventSummaries.shift(); // Remove the oldest event
    }
    console.log(`Reporting Event: ${fullEvent.eventType} to ${fullEvent.destination}`);
    sendToBSM(fullEvent);
}

function reportStatusUpdate(snapshot: Omit<AgentStatusSnapshot, 'agentId' | 'timestamp' | 'destination'>): void {
     const fullSnapshot: AgentStatusSnapshot = {
        ...snapshot,
        agentId: AGENT_ID,
        timestamp: new Date().toISOString(),
        destination: 'commander' // Status updates always go to the commander
    };
    // console.log(`Reporting Status Snapshot`); // Avoid excessive logging
    sendToBSM(fullSnapshot);
}


// --- Mineflayer Bot Setup ---
let bot: mineflayer.Bot;

function initializeBot() {
    console.log('Initializing Mineflayer bot...');
    bot = mineflayer.createBot({
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: AGENT_ID, // Use agent ID as username for simplicity
        version: MINECRAFT_VERSION,
        // auth: 'microsoft', // Add auth if needed
        checkTimeoutInterval: 60 * 1000, // 60 seconds
        plugins: {
            // Load custom plugins using require to bypass potential type issues
            pathfinder: require('@aetherius/pathfinder').createPlugin(),
            combat: require('@aetherius/combat'), // Assuming default export is the plugin function
        }
    });

    bot.once('spawn', () => {
        console.log(`Bot ${AGENT_ID} spawned successfully.`);
        // TODO: Initial status report?
        // reportStatusUpdate({ status: { /* initial state */ } });
    });

    bot.on('chat', (username, message) => {
        // Example: Respond to direct messages? Or just log?
        if (username === bot.username) return;
        console.log(`[CHAT] ${username}: ${message}`);
    });

    bot.on('kicked', (reason, loggedIn) => {
        console.error(`Bot ${AGENT_ID} kicked. Reason:`, reason);
        // TODO: Handle kick event, maybe try reconnecting?
    });

    bot.on('error', (err) => {
        console.error(`Bot ${AGENT_ID} error:`, err);
        // TODO: Handle bot errors
    });

    bot.on('end', (reason) => {
        console.log(`Bot ${AGENT_ID} disconnected. Reason: ${reason}`);
        // TODO: Handle disconnect, attempt reconnect?
        // setTimeout(initializeBot, 15000); // Example reconnect
    });

    // --- Key Inventory Summary ---
    function summarizeKeyInventory(): { name: string; count: number }[] {
        if (!bot?.inventory) return [];

        const summary: { [name: string]: number } = {};
        const items = bot.inventory.items(); // Get all items

        items.forEach(item => {
            // Basic check: include tools, weapons, armor, food, common resources
            // This requires minecraft-data to be available or more complex item type checking
            // For now, let's include items with names containing common keywords as a placeholder
            const name = item.name;
            const isKey = KEY_ITEM_CATEGORIES.some(cat => name.includes(cat)) || // Simple keyword check
                          name.includes('sword') || name.includes('pickaxe') || name.includes('axe') ||
                          name.includes('shovel') || name.includes('hoe') || name.includes('helmet') ||
                          name.includes('chestplate') || name.includes('leggings') || name.includes('boots') ||
                          name.includes('ore') || name.includes('log') || name.includes('planks') ||
                          name.includes('ingot') || name.includes('stick') || name.includes('coal') ||
                          name.includes('torch') || name.includes('crafting_table') || name.includes('furnace');

            if (isKey) {
                summary[name] = (summary[name] || 0) + item.count;
            }
        });

        // Convert to array format
        return Object.entries(summary).map(([name, count]) => ({ name, count }));
    }


    // --- Periodic Status Reporting ---
    setInterval(() => {
        if (bot?.entity && bot.inventory) { // Ensure inventory is loaded
             const keyInventorySummary = summarizeKeyInventory();
             const currentRecentEvents = [...recentEventSummaries]; // Copy the array

             reportStatusUpdate({
                status: {
                    health: bot.health,
                    hunger: bot.food,
                    saturation: bot.foodSaturation,
                    position: bot.entity.position,
                    // velocity: bot.entity.velocity, // Optional
                    // yaw: bot.entity.yaw, // Optional
                    // pitch: bot.entity.pitch, // Optional
                    onGround: bot.entity.onGround,
                    currentTaskDescription: taskExecutionManager.getCurrentTaskDescription(),
                    keyInventory: keyInventorySummary, // Include summary
                    recentEvents: currentRecentEvents // Include recent events
                }
            });
        }
    }, 5000); // Report status every 5 seconds

    // --- Load Core Modules ---
    // Initialize core modules here, passing the bot instance and reporting functions
    perceptionModule.initialize(bot, reportEvent);
    navigationModule.initialize(bot, reportEvent);
    combatModule.initialize(bot, reportEvent);
    mineModule.initialize(bot, reportEvent);
    inventoryModule.initialize(bot, reportEvent);
    craftingModule.initialize(bot, reportEvent);
    exploreModule.initialize(bot, reportEvent); // Initialize ExploreModule
}

// --- Command Validation Layer ---
function validateCommand(task: TaskObject): boolean {
    console.log(`Validating command: ${task.type}`);
    // TODO: Implement actual validation logic based on task type and agent state
    // e.g., check if required tools/materials are present for Craft/Build
    // e.g., check if target coordinates are reachable for NavigateTo
    return true; // Placeholder
}

// --- Task Execution Manager (TEM) ---
class TaskExecutionManager {
    private currentTask: { id: string; type: TaskType; details: any } | null = null;
    private taskQueue: { id: string; task: TaskObject }[] = [];

    constructor() {
        // TODO: Initialize
    }

    handleNewCommand(taskId: string, task: TaskObject) {
        console.log(`TEM received task ${taskId}: ${task.type}`);
        if (!validateCommand(task)) {
            console.warn(`Task ${taskId} rejected by validation.`);
            reportEvent({ eventType: 'taskRejected', taskId, details: { reason: 'Validation failed' } });
            return;
        }

        // Simple handling: Stop current task and execute new one immediately
        // TODO: Implement proper queueing, prioritization, preemption logic
        if (this.currentTask) {
            console.log(`Interrupting current task ${this.currentTask.id} for new task ${taskId}`);
            // TODO: Add logic to gracefully stop the current task in modules
            reportEvent({ eventType: 'taskFailed', taskId: this.currentTask.id, details: { reason: 'Interrupted by new task' } });
        }

        this.currentTask = { id: taskId, type: task.type, details: task.details };
        this.executeCurrentTask();
    }

    async executeCurrentTask() {
        if (!this.currentTask) return;

        const { id: taskId, type, details } = this.currentTask;
        console.log(`TEM executing task ${taskId}: ${type}`);
        let success = false;
        let failureReason = "Unknown execution error";

        try {
            // --- Delegate to Core Modules ---
            switch (type) {
                case 'NavigateTo':
                    // Ensure details match NavigateToDetails if using stricter types later
                    success = await navigationModule.navigateTo(details.targetCoords);
                    break;
                case 'Gather':
                    // Ensure details match GatherDetails
                    success = await mineModule.gather(details.resource, details.quantity, details.targetAreaCoords);
                    break;
                case 'Attack':
                     // Ensure details match AttackDetails
                     success = await combatModule.attack(details.targetEntityId);
                    break;
                case 'Guard':
                     // Ensure details match GuardDetails
                     success = await combatModule.guard(details.target, details.radius);
                     break;
                case 'Craft':
                     // Ensure details match CraftDetails
                     success = await craftingModule.craftItem(details.item, details.quantity, details.recipe);
                     break;
                case 'Explore':
                     // Ensure details match ExploreDetails
                     success = await exploreModule.exploreArea(details.area);
                     break;
                // Add cases for all other TaskTypes, calling the appropriate module function
                // e.g., Smelt, PlaceBlock, Build, Follow, Transport, ManageContainer
                default:
                    console.warn(`Task type ${type} not implemented in TEM.`);
                    failureReason = "Not Implemented";
                    success = false;
            }
        } catch (error: any) {
            console.error(`Error executing task ${taskId} (${type}):`, error);
            failureReason = error.message || "Exception during execution";
            success = false;
        }

        // --- Report Completion/Failure ---
        if (success) {
            console.log(`Task ${taskId} (${type}) completed successfully.`);
            reportEvent({ eventType: 'taskComplete', taskId, details: { result: "Success" } }); // Add actual results later
        } else {
            console.error(`Task ${taskId} (${type}) failed: ${failureReason}`);
            reportEvent({ eventType: 'taskFailed', taskId, details: { reason: failureReason } });
        }

        this.currentTask = null;
        // TODO: Check queue for next task
    }

    getCurrentTaskDescription(): string | undefined {
        return this.currentTask ? `${this.currentTask.type}` : undefined;
    }
}
const taskExecutionManager = new TaskExecutionManager();

// --- Core Modules (Skeletons) ---

// Define strategic block/item names (adjust as needed)
const STRATEGIC_RESOURCES = [
    'diamond_ore', 'lapis_ore', 'gold_ore', 'iron_ore', 'coal_ore', 'emerald_ore', // Ores
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', // Logs
    'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris' // Nether resources
];
const STRATEGIC_POIS = [
    'spawner', 'chest', 'end_portal_frame', 'nether_portal', // Functional blocks
    'village', // Structure hint (more complex detection needed for actual village)
    'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'brewing_stand', 'enchanting_table', 'anvil' // Utility blocks
];
const PERCEPTION_RADIUS = 16; // Scan radius around the bot
const PERCEPTION_INTERVAL = 10000; // Scan every 10 seconds

class PerceptionModule {
    private bot: mineflayer.Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;
    private perceptionIntervalId: NodeJS.Timeout | null = null;
    private knownNearbyBlocks: Set<string> = new Set(); // Track recently reported blocks to avoid spam

    initialize(botInstance: mineflayer.Bot, reportFunc: typeof reportEvent) {
        console.log("Perception Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;

        // Wait for bot to be ready before starting perception
        this.bot.once('spawn', () => {
             console.log("Perception Module Activated.");
             this.startPerceptionLoop();
        });

        this.bot.on('end', () => {
            this.stopPerceptionLoop();
        });
    }

    startPerceptionLoop() {
        if (this.perceptionIntervalId) return; // Already running
        console.log(`Starting perception loop (Interval: ${PERCEPTION_INTERVAL}ms, Radius: ${PERCEPTION_RADIUS})`);

        this.perceptionIntervalId = setInterval(() => {
            this.scanEnvironment();
        }, PERCEPTION_INTERVAL);

        // Initial scan
        this.scanEnvironment();
    }

    stopPerceptionLoop() {
        if (this.perceptionIntervalId) {
            console.log("Stopping perception loop.");
            clearInterval(this.perceptionIntervalId);
            this.perceptionIntervalId = null;
        }
         this.knownNearbyBlocks.clear(); // Clear cache on stop
    }

    scanEnvironment() {
        // Assign to local constants after null checks to satisfy TS strict null checks
        const bot = this.bot;
        const report = this.reportFunc;
        if (!bot || !report || !bot.entity) return;

        // console.log("Perception: Scanning environment..."); // Can be noisy

        const mcData = require('minecraft-data')(bot.version); // Use local bot constant
        if (!mcData) {
            console.error("Perception Error: Failed to load minecraft-data");
            return;
        }

        const blockTypesToFind = [
            ...STRATEGIC_RESOURCES.map(name => mcData.blocksByName[name]?.id).filter(id => id !== undefined),
            ...STRATEGIC_POIS.map(name => mcData.blocksByName[name]?.id).filter(id => id !== undefined)
        ];

        if (blockTypesToFind.length === 0) {
            console.warn("Perception: No valid block IDs found for strategic resources/POIs.");
            return;
        }

        const center = bot.entity.position; // Use local bot constant
        const options = {
            matching: blockTypesToFind,
            maxDistance: PERCEPTION_RADIUS,
            count: 50 // Limit number of blocks found per scan
        };

        try {
            const foundBlocks = bot.findBlocks(options); // Use local bot constant
            // console.log(`Perception: Found ${foundBlocks.length} potential blocks.`); // Debug log

            foundBlocks.forEach(blockPos => {
                const block = bot.blockAt(blockPos); // Use local bot constant (already checked for null)
                if (!block) return;

                const blockKey = `${block.name}_${blockPos.x}_${blockPos.y}_${blockPos.z}`;

                // Basic check to avoid reporting the same block repeatedly in short succession
                if (this.knownNearbyBlocks.has(blockKey)) {
                    return;
                }

                this.knownNearbyBlocks.add(blockKey);
                // Set a timeout to remove the block from the cache after a while
                setTimeout(() => this.knownNearbyBlocks.delete(blockKey), PERCEPTION_INTERVAL * 3); // Cache for 3 intervals

                const location = { x: blockPos.x, y: blockPos.y, z: blockPos.z };

                if (STRATEGIC_RESOURCES.includes(block.name)) {
                    report({ // Use local report constant
                        eventType: 'foundResource',
                        details: {
                            resourceType: block.name,
                            location: location,
                            quantityEstimate: 'Single' // TODO: Implement vein estimation?
                        },
                        // Destination is set automatically by reportEvent for this type
                    });
                } else if (STRATEGIC_POIS.includes(block.name)) {
                     report({ // Use local report constant
                        eventType: 'foundPOI',
                        details: {
                            poiType: block.name, // Use block name as POI type for simplicity
                            location: location,
                            // name: block.displayName // Optional: Use display name if available
                        },
                         // Destination is set automatically by reportEvent for this type
                    });
                }
            });
        } catch (error) {
             console.error("Perception Error during findBlocks:", error);
        }

        // TODO: Add entity scanning (e.g., passive mobs for food/resources, hostile mobs for threat assessment)
    }
}
const perceptionModule = new PerceptionModule();

class NavigationModule {
    private bot: Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;
    // No need to store defaultMovements instance

     initialize(botInstance: Bot, reportFunc: typeof reportEvent) {
        console.log("Navigation Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;

        // Ensure pathfinder plugin is loaded (should be done in initializeBot)
        // Use type casting for pathfinder until interface augmentation is done
        // Use type casting for pathfinder until interface augmentation is done
        const pathfinderInstance = (this.bot as any)?.pathfinder; // Add optional chaining for safety
        if (!pathfinderInstance) {
            console.error("Pathfinder plugin not loaded on bot instance!");
            return;
        }

        // Setup default movements (example, adjust as needed)
        // The Movements class might need mcData, check its constructor if issues arise
        const mcData = require('minecraft-data')(this.bot.version);
        // Note: The pathfinder plugin likely creates its own internal Movements instance.
        // We configure it here. If direct instantiation is needed, adjust import path.
        // For configuration, create a plain object matching the expected structure
        // For configuration, create a plain object matching the expected structure
        const movementConfig = {
             allowSprinting: true,
             canDig: true
             // Add other configuration properties expected by setMovements if needed
        };
        // Configure the instance created by the plugin
        pathfinderInstance.setMovements(movementConfig);
        console.log("Navigation Module Initialized.");
    }

    async navigateTo(coords: Coordinates): Promise<boolean> {
        const bot = this.bot; // Use local variable for type safety within async function
        const pathfinderInstance = (bot as any)?.pathfinder; // Use type casting with optional chaining
        if (!bot || !pathfinderInstance) {
            console.error("Navigation Error: Bot or Pathfinder not initialized.");
            return false;
        }

        console.log(`Navigation: Attempting to move to ${JSON.stringify(coords)}`);

        // Define the goal (adjust x,y,z based on GoalBlock requirements - e.g., block below feet)
        // Assuming GoalBlock targets the block *at* the coordinates.
        const goal = new GoalBlock(coords.x, coords.y, coords.z);

        return new Promise((resolve) => {
            const onGoalReached = () => {
                console.log(`Navigation: Goal reached at ${JSON.stringify(coords)}`);
                cleanupListeners();
                resolve(true);
            };

            const onPathError = (reason: string) => {
                 console.error(`Navigation Error: Pathfinding failed - ${reason}`);
                 cleanupListeners();
                 resolve(false);
            };

             // It seems the pathfinder might emit 'path_update' with status 'noPath' or 'timeout'
             // Or potentially a specific 'error' or 'abort' event. Adjust based on actual plugin behavior.
            const onPathUpdate = (results: any) => {
                if (results?.status === 'noPath' || results?.status === 'timeout') {
                    console.error(`Navigation Error: Path update status - ${results.status}`);
                    cleanupListeners();
                    resolve(false);
                }
                 // console.log(`Path update: ${results?.status}`); // Optional debug log
            };

            // Declare with let to allow reassignment later for timeout clearing
            // Declare with let to allow reassignment later for timeout clearing
            let cleanupListeners = () => { // Ensure 'let' is used for reassignment
                pathfinderInstance.removeListener('goal_reached', onGoalReached);
                pathfinderInstance.removeListener('error', onPathError); // Assuming an 'error' event
                pathfinderInstance.removeListener('path_update', onPathUpdate); // Assuming 'path_update' for errors
                pathfinderInstance.removeListener('abort', onPathError); // Assuming an 'abort' event
            };

            // Attach listeners
            pathfinderInstance.once('goal_reached', onGoalReached);
            pathfinderInstance.once('error', onPathError); // Adjust event name if needed
            pathfinderInstance.on('path_update', onPathUpdate); // Listen continuously for path errors
            pathfinderInstance.once('abort', onPathError); // Adjust event name if needed


            // Set the goal to start pathfinding
            pathfinderInstance.setGoal(goal, true); // Dynamic path recalculation enabled

             // Optional: Add a timeout for the entire navigation task
             const navigationTimeout = setTimeout(() => {
                 console.error(`Navigation Error: Task timed out after 60 seconds.`);
                 pathfinderInstance.stop(); // Stop pathfinding
                 cleanupListeners();
                 resolve(false);
             }, 60000); // 60 second timeout

             // Clear timeout listener on cleanup
             // Wrap cleanupListeners to include timeout clearing
             const originalCleanup = cleanupListeners;
             cleanupListeners = () => { // Reassign the 'let' declared variable
                 clearTimeout(navigationTimeout);
                 originalCleanup();
             };
        });
    }
    // Add navigateToGoalFollowEntity, navigateToGoalBlock etc.
}
const navigationModule = new NavigationModule();

// ... Add skeleton classes for Inventory, Crafting, Mine, Combat, Explore ...
class CombatModule {
    private bot: Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;
    private combatPlugin: any = null; // Store reference to plugin API (e.g., bot.swordpvp)

     initialize(botInstance: Bot, reportFunc: typeof reportEvent) {
        console.log("Combat Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;

        // Access the plugin loaded onto the bot instance
        // Assuming the plugin adds 'swordpvp' and/or 'bowpvp' based on its README
        // Use type casting as TypeScript won't know about dynamically added plugin properties
        this.combatPlugin = (this.bot as any)?.swordpvp; // Prioritize sword for now

        if (!this.combatPlugin) {
             console.warn("Combat plugin (swordpvp) not found on bot instance! Trying bowpvp...");
             // Attempt to access bowpvp as fallback?
             this.combatPlugin = (this.bot as any)?.bowpvp;
             if (!this.combatPlugin) {
                 console.error("Combat plugin (swordpvp/bowpvp) not found! Combat module disabled.");
                 return; // Disable module if plugin isn't loaded
             } else {
                 console.log("Using bowpvp for combat.");
             }
        } else {
             console.log("Using swordpvp for combat.");
        }
        console.log("Combat Module Initialized.");
        // TODO: Configure combat plugin options if needed (e.g., bot.swordpvp.options...)
    }

     async attack(targetEntityId: string): Promise<boolean> {
         const bot = this.bot;
         const combatApi = this.combatPlugin;
         if (!bot || !combatApi) {
             console.error("Combat Error: Bot or Combat Plugin not initialized.");
             return false;
         }

         console.log(`Combat: Attempting to attack entity ${targetEntityId}`);

         // Find the entity object by its ID (or potentially username)
         // Note: bot.entities might store entities by numerical ID or UUID depending on version/server
         const targetEntity = Object.values(bot.entities).find(entity =>
             entity.uuid === targetEntityId || // Check UUID
             (entity.id !== undefined && entity.id.toString() === targetEntityId) || // Check numerical ID (convert both to string for comparison)
             entity.username === targetEntityId // Check username
         );


         if (!targetEntity) {
             console.error(`Combat Error: Target entity '${targetEntityId}' not found.`);
             // Report failure back?
             // this.reportFunc?.({ eventType: 'taskFailed', details: { reason: `Target entity ${targetEntityId} not found` } });
             return false;
         }

         try {
             // Call the plugin's attack method
             // Assuming the API is bot.swordpvp.attack(entity) or similar
             if (typeof combatApi.attack !== 'function') {
                 console.error(`Combat Error: Combat plugin does not have an 'attack' function.`);
                 return false;
             }
             combatApi.attack(targetEntity);
             // The combat plugin likely handles the attack loop internally.
             // We might need listeners for completion/failure if the plugin provides them.
             console.log(`Combat: Attack command issued for ${targetEntityId}.`);
             // For now, assume command issuance is success. Need event handling for true success.
             // Consider reporting taskProgress here?
             return true;
         } catch (error: any) {
             console.error(`Combat Error: Failed to execute attack command for ${targetEntityId}:`, error);
             return false;
         }
     }

     async guard(target: {entityId: string} | {location: Coordinates}, radius: number): Promise<boolean> {
         const bot = this.bot;
         const combatApi = this.combatPlugin;
          if (!bot || !combatApi) {
             console.error("Combat Error: Bot or Combat Plugin not initialized.");
             return false;
         }

         // The @aetherius/combat plugin's guard function might differ.
         // Placeholder logic assuming it takes a position and radius.
         // We need to resolve the entityId to a position if provided.
         let guardPosition: Coordinates | null = null;

         if ('location' in target) {
             guardPosition = target.location;
         } else if ('entityId' in target) {
             const targetEntity = Object.values(bot.entities).find(entity =>
                 entity.uuid === target.entityId ||
                 (entity.id !== undefined && entity.id.toString() === target.entityId) ||
                 entity.username === target.entityId
             );
             if (targetEntity) {
                 guardPosition = targetEntity.position;
             } else {
                  console.error(`Combat Error: Guard target entity ${target.entityId} not found.`);
                  return false;
             }
         }

         if (!guardPosition) {
              console.error(`Combat Error: Could not determine guard position.`);
              return false;
         }

         console.log(`Combat: Attempting to guard position ${JSON.stringify(guardPosition)} within ${radius}m`);

         try {
             // Assuming an API like bot.swordpvp.guard(position, radius)
             // The actual API might differ, consult the plugin docs/code.
             if (typeof combatApi.guard === 'function') {
                 combatApi.guard(guardPosition, radius); // Call the guard function
                 console.log(`Combat: Guard command issued.`);
                 // Assume command issuance is success. Need event handling for confirmation/failure.
                 return true;
             } else {
                  console.error(`Combat Error: Plugin does not support guard function.`);
                  return false;
             }
         } catch (error: any) {
             console.error(`Combat Error: Failed to execute guard command:`, error);
             return false;
         }
     }
}
const combatModule = new CombatModule();

class MineModule {
    private bot: Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;
    private mcData: any = null;

     initialize(botInstance: Bot, reportFunc: typeof reportEvent) {
        console.log("Mine Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;
        this.mcData = require('minecraft-data')(botInstance.version);
        console.log("Mine Module Initialized.");
    }

     async gather(resource: string, quantity: number, targetArea?: Coordinates): Promise<boolean> {
         const bot = this.bot;
         if (!bot || !this.mcData) {
             console.error("Mining Error: Bot or mcData not initialized.");
             return false;
         }
         console.log(`Mining: Attempting to gather ${quantity} of ${resource} ${targetArea ? `near ${JSON.stringify(targetArea)}` : ''}`);

         const item = this.mcData.itemsByName[resource] || this.mcData.blocksByName[resource];
         if (!item) {
             console.error(`Mining Error: Unknown resource type ${resource}`);
             return false;
         }

         let gatheredCount = 0;
         while (gatheredCount < quantity) {
             // Find the nearest block of the target resource type
             // TODO: Incorporate targetArea if provided
             const block = bot.findBlock({
                 matching: item.id,
                 maxDistance: 64, // Search radius
                 // Use point: targetArea ? new Vec3(targetArea.x, targetArea.y, targetArea.z) : bot.entity.position // Requires Vec3 import
             });

             if (!block) {
                 console.log(`Mining: No more ${resource} found nearby.`);
                 // Report partial success or failure based on gatheredCount vs quantity
                 return gatheredCount > 0;
             }

             console.log(`Mining: Found ${resource} at ${block.position}`);

             // Navigate to the block (use NavigationModule)
             const reached = await navigationModule.navigateTo(block.position);
             if (!reached) {
                 console.error(`Mining Error: Failed to navigate to ${resource} at ${block.position}`);
                 // Consider blacklisting this block or area?
                 return false; // Or report partial success if some were gathered
             }

             // Ensure the bot has the right tool equipped (basic check)
             // TODO: Implement proper tool selection logic
             const pathfinderInstance = (bot as any)?.pathfinder; // Use type casting
             const bestTool = pathfinderInstance?.bestHarvestTool(block); // Use pathfinder's tool check if available
             if (bestTool) {
                 await inventoryModule.equip(bestTool.name, 'hand'); // Use InventoryModule to equip
             } else if (block.material && !bot.heldItem?.name.includes('pickaxe')) { // Simple fallback
                 console.warn(`Mining Warning: No suitable tool found for ${resource}, attempting with hand/current item.`);
             }

             // Dig the block
             try {
                 console.log(`Mining: Digging ${resource} at ${block.position}`);
                 await bot.dig(block);
                 gatheredCount++; // Increment count - assumes 1 drop per block for simplicity
                 console.log(`Mining: Gathered ${gatheredCount}/${quantity} of ${resource}`);
                 // Mineflayer's dig usually handles collection, but bot.collectBlock could be used if needed
             } catch (err: any) {
                 console.error(`Mining Error: Failed to dig ${resource} at ${block.position}:`, err.message);
                 return false; // Failed to dig this block
             }
         }

         console.log(`Mining: Successfully gathered ${gatheredCount}/${quantity} of ${resource}.`);
         return true;
     }
}
const mineModule = new MineModule();

class InventoryModule {
    private bot: Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;
    private mcData: any = null; // To store minecraft-data

    initialize(botInstance: Bot, reportFunc: typeof reportEvent) {
        console.log("Inventory Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;
        this.mcData = require('minecraft-data')(botInstance.version);
        console.log("Inventory Module Initialized.");
    }

    async equip(itemType: string, destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'): Promise<boolean> {
        const bot = this.bot;
        if (!bot || !this.mcData) {
             console.error("Inventory Error: Bot or mcData not initialized.");
             return false;
        }
        console.log(`Inventory: Attempting to equip ${itemType} to ${destination}`);
        try {
            const item = this.findItem(itemType); // Find item first
            if (!item) {
                console.error(`Inventory Error: Item ${itemType} not found to equip.`);
                return false;
            }
            await bot.equip(item, destination);
            console.log(`Inventory: Successfully equipped ${itemType} to ${destination}.`);
            return true;
        } catch (error: any) {
            console.error(`Inventory Error: Failed to equip ${itemType}:`, error);
            return false;
        }
    }

    async toss(itemType: string, quantity: number | null): Promise<boolean> {
         const bot = this.bot;
         if (!bot || !this.mcData) {
             console.error("Inventory Error: Bot or mcData not initialized.");
             return false;
         }
         console.log(`Inventory: Attempting to toss ${quantity ?? 'all'} of ${itemType}`);
         try {
             const item = this.findItem(itemType); // Find item first
             if (!item) {
                 console.error(`Inventory Error: Item ${itemType} not found to toss.`);
                 return false;
             }
             if (quantity === null || quantity >= item.count) {
                 // Toss the whole stack
                 await bot.tossStack(item);
                 console.log(`Inventory: Tossed entire stack of ${itemType}.`);
             } else {
                 // Toss specific quantity
                 await bot.toss(item.type, null, quantity); // metadata is null for now
                 console.log(`Inventory: Tossed ${quantity} of ${itemType}.`);
             }
             return true;
         } catch (error: any) {
             console.error(`Inventory Error: Failed to toss ${itemType}:`, error);
             return false;
         }
    }

    findItem(itemType: string): Item | null {
        const bot = this.bot;
        if (!bot || !bot.inventory || !this.mcData) {
             console.error("Inventory Error: Bot, inventory, or mcData not initialized for findItem.");
             return null;
        }
        // Find item by name using minecraft-data to get the ID
        const itemData = this.mcData.itemsByName[itemType];
        if (!itemData) {
            console.warn(`Inventory Warning: Unknown item name '${itemType}' for findItem.`);
            return null;
        }
        // Use findInventoryItem with the correct item ID and pass false for useByName
        return bot.inventory.findInventoryItem(itemData.id, null, false);
    }

     itemCount(itemType: string): number {
         const bot = this.bot;
          if (!bot || !bot.inventory || !this.mcData) {
             console.error("Inventory Error: Bot, inventory, or mcData not initialized for itemCount.");
             return 0;
         }
         // Find item ID from name
         const itemData = this.mcData.itemsByName[itemType];
         if (!itemData) {
             console.warn(`Inventory Warning: Unknown item name '${itemType}' for itemCount.`);
             return 0;
         }
         // Use bot.inventory.count with item ID
         return bot.inventory.count(itemData.id, null); // metadata is null for now
     }
}
const inventoryModule = new InventoryModule(); // Instantiate

class CraftingModule {
    private bot: Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;
    private mcData: any = null;

    initialize(botInstance: Bot, reportFunc: typeof reportEvent) {
        console.log("Crafting Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;
        this.mcData = require('minecraft-data')(botInstance.version);
        console.log("Crafting Module Initialized.");
    }

    async craftItem(itemType: string, quantity: number = 1, recipe?: Recipe): Promise<boolean> {
        const bot = this.bot;
        if (!bot || !this.mcData) {
            console.error("Crafting Error: Bot or mcData not initialized.");
            return false;
        }
        console.log(`Crafting: Attempting to craft ${quantity} of ${itemType}`);

        try {
            const item = this.mcData.itemsByName[itemType];
            if (!item) {
                console.error(`Crafting Error: Unknown item type ${itemType}`);
                return false;
            }

            const recipes = bot.recipesFor(item.id, null, 1, null); // Find recipes for the item
            if (!recipes || recipes.length === 0) {
                 console.error(`Crafting Error: No recipe found for ${itemType}`);
                 return false;
            }

            // Use provided recipe or the first available one
            const recipeToUse = recipe || recipes[0];

            // Check if crafting table is needed and available nearby
            let craftingTable: Block | null = null; // Use Block type
            if (recipeToUse.requiresTable) {
                craftingTable = bot.findBlock({
                    matching: this.mcData.blocksByName.crafting_table.id,
                    maxDistance: 4, // Look within 4 blocks
                });
                if (!craftingTable) {
                    console.warn(`Crafting Warning: Crafting table required for ${itemType} but none found nearby.`);
                    // TODO: Add logic to place a crafting table if available in inventory
                    return false; // Fail for now if table needed but not found
                }
            }

            console.log(`Crafting: Using recipe for ${itemType}. Table needed: ${recipeToUse.requiresTable}`);
            await bot.craft(recipeToUse, quantity, craftingTable ?? undefined); // Convert null to undefined
            console.log(`Crafting: Successfully crafted ${quantity} of ${itemType}.`);
            // TODO: Add logic to reclaim crafting table if placed by the bot
            return true;

        } catch (error: any) {
            console.error(`Crafting Error: Failed to craft ${itemType}:`, error);
            return false;
        }
    }
}
const craftingModule = new CraftingModule(); // Instantiate

class ExploreModule { // Added Skeleton
    private bot: Bot | null = null;
    private reportFunc: typeof reportEvent | null = null;

    initialize(botInstance: Bot, reportFunc: typeof reportEvent) {
        console.log("Explore Module Initializing...");
        this.bot = botInstance;
        this.reportFunc = reportFunc;
        console.log("Explore Module Initialized.");
    }

    async exploreArea(area?: { center: Coordinates; radius: number }): Promise<boolean> {
        console.log(`Exploring ${area ? `area around ${JSON.stringify(area.center)} with radius ${area.radius}` : 'current vicinity'} (Not Implemented)`);
        // TODO: Implement exploration logic (e.g., random walk, systematic scan, follow terrain)
        // Could potentially use NavigationModule for movement.
        // Should likely run for a duration or until a specific condition is met.
        await new Promise(resolve => setTimeout(resolve, 5000)); // Simulate exploring for 5 seconds
        console.log("Exploration step finished (Placeholder).");
        return true; // Placeholder success
    }
}
const exploreModule = new ExploreModule(); // Instantiate


// --- Main Execution ---

function handleIncomingCommand(taskId: string, task: TaskObject) {
    taskExecutionManager.handleNewCommand(taskId, task);
}

// Start BSM connection first
connectToBSM();

// Initialize the bot once BSM connection is likely established (or handle async better)
// A small delay might prevent race conditions on startup, but a more robust
// mechanism (e.g., waiting for BSM registration ACK) would be better.
setTimeout(() => {
    if (isRegisteredWithBSM) {
        initializeBot();
    } else {
        console.warn("Delay ended but not registered with BSM. Bot initialization postponed.");
        // Need logic here to trigger initializeBot once registration happens if connectToBSM succeeds later.
    }
}, 2000); // Wait 2 seconds after starting BSM connection attempt


// --- Graceful Shutdown ---
function agentShutdown() {
    console.log(`Agent ${AGENT_ID} shutting down...`);
    if (bot) {
        bot.quit('Agent shutting down');
    }
    if (bsmSocket && !bsmSocket.destroyed) {
        bsmSocket.end(); // Close TCP connection gracefully
    }
    // Give time for cleanup
    setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', agentShutdown);
process.on('SIGINT', agentShutdown);
