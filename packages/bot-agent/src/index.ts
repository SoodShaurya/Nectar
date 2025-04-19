import mineflayer from '@aetherius/mineflayer-core';
import net from 'net';
import { AgentEvent, AgentStatusSnapshot, TaskObject, WebSocketMessage, TaskType } from '@aetherius/shared-types';

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
            // Load custom plugins here if needed, e.g., pathfinder, combat
            // pathfinder: require('@aetherius/pathfinder'), // Example
            // combat: require('@aetherius/combat') // Example
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
    // ... initialize other modules
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
                    success = await navigationModule.navigateTo(details.targetCoords);
                    break;
                case 'Gather':
                    // success = await mineModule.gather(details.resource, details.quantity, details.targetAreaCoords);
                    console.log("Gather task execution not implemented yet."); success = false; failureReason = "Not Implemented";
                    break;
                case 'Attack':
                     // success = await combatModule.attack(details.targetEntityId);
                     console.log("Attack task execution not implemented yet."); success = false; failureReason = "Not Implemented";
                    break;
                // Add cases for all other TaskTypes, calling the appropriate module function
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
        if (!this.bot || !this.reportFunc || !this.bot.entity) return;

        // console.log("Perception: Scanning environment..."); // Can be noisy

        const mcData = require('minecraft-data')(this.bot.version); // Load mcData here
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

        const center = this.bot.entity.position;
        const options = {
            matching: blockTypesToFind,
            maxDistance: PERCEPTION_RADIUS,
            count: 50 // Limit number of blocks found per scan
        };

        try {
            const foundBlocks = this.bot.findBlocks(options);
            // console.log(`Perception: Found ${foundBlocks.length} potential blocks.`); // Debug log

            foundBlocks.forEach(blockPos => {
                const block = this.bot?.blockAt(blockPos);
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
                    this.reportFunc({
                        eventType: 'foundResource',
                        details: {
                            resourceType: block.name,
                            location: location,
                            quantityEstimate: 'Single' // TODO: Implement vein estimation?
                        },
                        // Destination is set automatically by reportEvent for this type
                    });
                } else if (STRATEGIC_POIS.includes(block.name)) {
                     this.reportFunc({
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
     initialize(botInstance: mineflayer.Bot, reportFunc: typeof reportEvent) {
        console.log("Navigation Module Initialized (Placeholder)");
        // TODO: Load pathfinder plugin if used
    }
    async navigateTo(coords: any): Promise<boolean> {
        console.log(`Navigation: Moving to ${JSON.stringify(coords)} (Not Implemented)`);
        // TODO: Implement using pathfinder plugin
        await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate movement
        return false; // Placeholder
    }
    // Add navigateToGoalFollowEntity, navigateToGoalBlock etc.
}
const navigationModule = new NavigationModule();

// ... Add skeleton classes for Inventory, Crafting, Mine, Combat, Explore ...
class CombatModule {
     initialize(botInstance: mineflayer.Bot, reportFunc: typeof reportEvent) {
        console.log("Combat Module Initialized (Placeholder)");
        // TODO: Load combat plugin
    }
     async attack(targetEntityId: string): Promise<boolean> {
         console.log(`Combat: Attacking ${targetEntityId} (Not Implemented)`);
         // TODO: Implement using combat plugin
         return false;
     }
     async guard(target: any, radius: number): Promise<boolean> {
         console.log(`Combat: Guarding ${JSON.stringify(target)} within ${radius}m (Not Implemented)`);
         // TODO: Implement using combat plugin
         return false;
     }
}
const combatModule = new CombatModule();


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