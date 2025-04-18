// Determine which engine to load
const useCustomEngine = process.env.USE_CUSTOM_ENGINE === 'true'; // Check for 'true' string
let mineflayer;

if (useCustomEngine) {
    console.log('Using custom engine from ../../engine');
    try {
        mineflayer = require('../../engine'); // Assuming engine/index.js is the entry point
    } catch (err) {
        console.error("Error loading custom engine from '../../engine'. Falling back to installed mineflayer.", err);
        mineflayer = require('mineflayer'); // Fallback
    }
} else {
    console.log('Using installed mineflayer package');
    mineflayer = require('mineflayer');
}

const { Vec3 } = require('vec3'); // Import Vec3
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client'); // Added for viewer connection
const botMemoryPlugin = require('../../engine/lib/plugins/botMemory'); // Load the memory plugin
const { createPlugin: pathfinderPluginLoader } = require('../../pathfinder/dist/index.js'); // Use correct path to compiled JS entry point
const combatPluginLoader = require('../../combat/lib/index.js').default; // Corrected path to lib, Load the combat plugin (assuming default export)

// Define default view distance, can be made configurable later
const VIEW_DISTANCE = 6;
const BOT_DISTANCE_UPDATE_INTERVAL = 5000; // ms - How often to update distances between bots

let activeBots = {}; // Store bot instances and data: { botId: { bot: instance, status: '...', activity: '...', options: {...}, viewerSocket: socketInstance, primitives: {} } }
let broadcast; // Function to send messages to all clients
let botDistanceUpdateInterval = null; // Interval ID for distance updates
let playerThreatBoosts = {}; // { playerName: boostAmount } - Stores persistent threat boosts

const activitiesDir = path.join(__dirname, 'activities');

// --- Threat Boost Management ---
function getPlayerThreatBoost(playerName) {
    return playerThreatBoosts[playerName] || 0;
}

function updatePlayerThreatBoost(playerName, boostToAdd) {
    const currentBoost = getPlayerThreatBoost(playerName);
    playerThreatBoosts[playerName] = currentBoost + boostToAdd;
    console.log(`[ThreatBoost] Updated boost for ${playerName}. Added: ${boostToAdd}, New Total: ${playerThreatBoosts[playerName]}`);
    // TODO: Consider persisting this data if needed across manager restarts
}

// --- Helper Function ---
function isManagedBot(playerName) {
    // Check if any active bot has the given username
    return Object.values(activeBots).some(botData => botData.options?.username === playerName);
}

// --- Initialization ---
function init(broadcastFunction) {
    broadcast = broadcastFunction;
    console.log('Bot Manager Initialized.');
    // Load available activities on startup
    getAvailableActivities();
    // Start periodic bot distance updates
    startBotDistanceUpdates();
}

// --- Bot Distance Calculation ---
function updateBotDistances() {
    const botEntries = Object.entries(activeBots);
    const distances = {}; // { targetBotId: { sourceBotId: distance } }

    // Calculate distances between all valid bot pairs
    for (let i = 0; i < botEntries.length; i++) {
        const [botIdA, dataA] = botEntries[i];
        if (!dataA.bot || !dataA.bot.entity || !dataA.bot.entity.position) continue;

        distances[botIdA] = {}; // Initialize distance map for bot A

        for (let j = i + 1; j < botEntries.length; j++) {
            const [botIdB, dataB] = botEntries[j];
            if (!dataB.bot || !dataB.bot.entity || !dataB.bot.entity.position) continue;

            const dist = dataA.bot.entity.position.distanceTo(dataB.bot.entity.position);
            distances[botIdA][botIdB] = dist;

            // Ensure symmetry
            if (!distances[botIdB]) distances[botIdB] = {};
            distances[botIdB][botIdA] = dist;
        }
    }

    // Push updates to each bot's memory
    for (const [botId, data] of botEntries) {
        if (data.bot && data.bot.memory && distances[botId]) {
            data.bot.memory._updateBotDistances(distances[botId]);
        }
    }
}

function startBotDistanceUpdates() {
    if (botDistanceUpdateInterval) {
        clearInterval(botDistanceUpdateInterval);
    }
    console.log(`Starting bot distance updates every ${BOT_DISTANCE_UPDATE_INTERVAL}ms`);
    botDistanceUpdateInterval = setInterval(updateBotDistances, BOT_DISTANCE_UPDATE_INTERVAL);
}

function stopBotDistanceUpdates() {
    if (botDistanceUpdateInterval) {
        console.log('Stopping bot distance updates.');
        clearInterval(botDistanceUpdateInterval);
        botDistanceUpdateInterval = null;
    }
}


// --- Bot Management ---
function createBot(options) {
    const { host, port, username, version } = options;
    if (!host || !port || !username) {
        console.error('Create bot failed: Missing required options.');
        // Optionally send an error back to the specific client if possible,
        // but for now, we rely on broadcasting the (unchanged) bot list.
        return;
    }

    const botId = `${username}@${host}:${port}`; // Simple unique ID
    if (activeBots[botId]) {
        console.warn(`Bot ${botId} already exists or is being created.`);
        return; // Prevent duplicates
    }

    console.log(`Creating bot ${botId} with options:`, options);
    // Store initial state, including viewerSocket and primitives store
    activeBots[botId] = {
        bot: null,
        status: 'connecting',
        activity: null,
        options: options,
        activityInterval: null, // Interval for the *activity* itself, if any
        defenseMonitorInterval: null, // Interval for the persistent defense monitor
        viewerSocket: null, // Initialize viewer socket
        primitives: {} // Store drawn primitives for this bot
    };
    broadcastBotList(); // Notify frontend about the new bot entry

    try {
        const bot = mineflayer.createBot({
            host: host,
            port: parseInt(port, 10), // Ensure port is an integer
            username: username,
            version: version, // Optional, let mineflayer handle default if undefined
            auth: 'offline', // As requested
            checkTimeoutInterval: 60 * 1000, // Increase timeout interval
            plugins: [ // Use array format for plugins when using loader functions
                botMemoryPlugin, // Load the memory plugin
                pathfinderPluginLoader({ // Pass options object
                    moveSettings: {
                        canDig: true, // Explicitly keep true
                    }
                }), // Load the pathfinder plugin using its exported loader
                combatPluginLoader // Load the combat plugin
                // Add any other essential plugins if needed later
            ]
        });

        bot.botManagerRef = module.exports; // Attach manager reference
        activeBots[botId].bot = bot;


        // --- Viewer Integration ---
        const viewerSocket = io('ws://localhost:6900/viewer', { // Connect to the viewer namespace
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
        });
        activeBots[botId].viewerSocket = viewerSocket;

        viewerSocket.on('connect', () => {
            console.log(`Bot ${botId} connected to viewer namespace with socket ID ${viewerSocket.id}`);
            viewerSocket.emit('identifyAsBot', { botId });

            // Send initial primitives if any were added before connection (unlikely but possible)
             for (const id in activeBots[botId]?.primitives) {
                 viewerSocket.emit('viewerData', { botId, payload: { type: 'primitive', data: activeBots[botId].primitives[id] } });
             }
        });

        viewerSocket.on('disconnect', (reason) => {
            console.log(`Bot ${botId} disconnected from viewer namespace. Reason: ${reason}`);
        });

        viewerSocket.on('connect_error', (err) => {
            console.error(`Bot ${botId} viewer connection error: ${err.message}`);
        });

        // --- Bot Event Listeners ---

        // Basic position updates for the viewer
        const sendViewerPosition = () => {
            if (bot && bot.entity && bot.entity.position && viewerSocket.connected && activeBots[botId]) {
                 const payload = {
                     type: 'position',
                     data: {
                         pos: bot.entity.position,
                         yaw: bot.entity.yaw,
                         pitch: bot.entity.pitch, // Send pitch for potential first-person view later
                         addMesh: true // Tell frontend to draw the bot mesh
                     }
                 };
                 viewerSocket.emit('viewerData', { botId, payload });
            }
        };
        // TODO: Add listeners for chunk loading, entities, etc. for a full world view
        // This requires adapting WorldView logic or similar, which is complex.
        // For now, only sending position.

        bot.on('move', sendViewerPosition); // Send position frequently on move

        bot.once('spawn', () => {
            console.log(`Bot ${botId} spawned.`);
            if (!activeBots[botId]) return; // Guard against race conditions if bot deleted quickly

            activeBots[botId].status = 'idle';
            sendViewerPosition(); // Send initial position to viewer

            // Start memory updates and set initial activity in memory
            if (bot.memory) {
                bot.memory.startUpdating();
                bot.memory._setActivity('idle'); // Initial state before specific activity loads
            }

            // Load default activity after spawn
            changeActivity(botId, 'stand_still'); // Default activity

            // --- Start Persistent Defense Monitor ---
            if (activeBots[botId] && !activeBots[botId].defenseMonitorInterval) {
                console.log(`[BotManager ${botId}] Starting persistent defense monitor.`);
                activeBots[botId].defenseMonitorInterval = setInterval(() => {
                    const botData = activeBots[botId];
                    // Ensure bot and memory are still valid
                    if (!botData || !botData.bot || !botData.bot.memory || !botData.bot.entity) {
                        // console.warn(`[DefenseMonitor ${botId}] Bot or memory not available, skipping check.`);
                        return;
                    }

                    try {
                        // Removed check for currentActivity === 'combat' to allow dynamic target switching

                        const nearbyEntities = botData.bot.memory.getNearbyEntities();
                        const playerThreats = [];
                        const otherThreats = [];
                        const THREAT_RADIUS = 12; // Define threat radius locally
                        let primaryThreat = null;

                        // Categorize threats
                        for (const id in nearbyEntities) {
                            const entityData = nearbyEntities[id];
                            if (entityData.threatLevel > 0 && entityData.distance <= THREAT_RADIUS) {
                                if (entityData.type === 'player') {
                                    playerThreats.push(entityData);
                                } else {
                                    otherThreats.push(entityData);
                                }
                            }
                        }

                        // Prioritize closest player threat
                        if (playerThreats.length > 0) {
                            playerThreats.sort((a, b) => a.distance - b.distance); // Sort by distance ascending
                            primaryThreat = playerThreats[0];
                        }
                        // If no player threats, target closest other threat
                        else if (otherThreats.length > 0) {
                            otherThreats.sort((a, b) => a.distance - b.distance); // Sort by distance ascending
                            primaryThreat = otherThreats[0];
                        }

                        // Engage if a primary threat was selected
                        if (primaryThreat) {
                            const targetName = primaryThreat.username || primaryThreat.name || 'Unknown Threat';
                            const newTargetIdentifier = primaryThreat.username || primaryThreat.id;
                            const currentTargetId = botData.bot.memory.getCombatTargetId();
                            const currentActivity = botData.bot.memory.getCurrentActivity(); // Get current activity

                            // Engage if not already in combat OR if the highest priority target has changed
                            if (currentActivity !== 'combat' || newTargetIdentifier !== currentTargetId) {
                                console.log(`[DefenseMonitor ${botId}] New/Different threat detected: ${targetName} (Threat: ${primaryThreat.threatLevel}, Dist: ${primaryThreat.distance.toFixed(1)}). Engaging.`);

                                // Store the activity being interrupted
                                botData.bot.memory.setInterruptedActivity(currentActivity || 'stand_still'); // Default to stand_still if null

                                // Get levels for chat message
                                const botStrength = botData.bot.memory.getStrengthLevel();
                                const targetThreat = primaryThreat.threatLevel; // Already calculated

                                // Send chat message
                                botData.bot.chat(`Engaging ${targetName}! My Strength: ${botStrength}, Target Threat: ${targetThreat}`);

                                // Set combat target in memory
                                setBotCombatTarget(botId, newTargetIdentifier);

                                // Switch activity to combat (this will unload the current activity if already running)
                                changeActivity(botId, 'combat');
                            }
                            // else {
                                // Optional: Log that the target remains the same and no action is needed
                                // console.log(`[DefenseMonitor ${botId}] Target ${targetName} is already the current combat target. No switch needed.`);
                            // }
                        }
                    } catch(error) {
                         console.error(`[DefenseMonitor ${botId}] Error during check:`, error);
                    }

                }, 200); // Check every 200ms
            }
            // --- End Persistent Defense Monitor ---

            broadcastBotList();
        });

        bot.on('error', (err) => {
            console.error(`Bot ${botId} error:`, err);
            if (activeBots[botId]) {
                 activeBots[botId].status = `error: ${err.message}`;
                 // Clear intervals on error
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                 if (activeBots[botId].defenseMonitorInterval) {
                    clearInterval(activeBots[botId].defenseMonitorInterval);
                    activeBots[botId].defenseMonitorInterval = null;
                 }
                 activeBots[botId].activity = 'error';

                 // Update memory and stop updates
                 if (bot.memory) {
                     bot.memory._setActivity('error');
                     bot.memory.stopUpdating();
                 }

                 // Disconnect viewer socket on error
                 if (activeBots[botId].viewerSocket) {
                     activeBots[botId].viewerSocket.disconnect();
                 }
            }
            broadcastBotList();
            // Note: We don't delete activeBots[botId].bot here, allows potential reconnect logic later if desired
        });

        bot.on('kicked', (reason) => {
            console.log(`Bot ${botId} kicked for:`, reason);
             if (activeBots[botId]) {
                activeBots[botId].status = `kicked: ${reason}`;
                 // Clear intervals on kick
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                 if (activeBots[botId].defenseMonitorInterval) {
                    clearInterval(activeBots[botId].defenseMonitorInterval);
                    activeBots[botId].defenseMonitorInterval = null;
                 }
                activeBots[botId].activity = 'kicked';

                // Update memory and stop updates
                if (bot.memory) {
                    bot.memory._setActivity('kicked');
                    bot.memory.stopUpdating();
                }

                 // Disconnect viewer socket on kick
                 if (activeBots[botId].viewerSocket) {
                     activeBots[botId].viewerSocket.disconnect();
                 }
                delete activeBots[botId].bot; // Remove bot instance on kick
             }
            broadcastBotList();
        });

        bot.once('end', (reason) => {
            console.log(`Bot ${botId} disconnected. Reason: ${reason}`);
            // Remove the 'move' listener specific to this bot instance
            bot.removeListener('move', sendViewerPosition);
            if (activeBots[botId]) {
                activeBots[botId].status = `disconnected: ${reason}`;
                 // Clear intervals on end
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                 if (activeBots[botId].defenseMonitorInterval) {
                    clearInterval(activeBots[botId].defenseMonitorInterval);
                    activeBots[botId].defenseMonitorInterval = null;
                 }
                activeBots[botId].activity = 'disconnected';

                // Update memory and stop updates
                if (bot.memory) {
                    bot.memory._setActivity('disconnected');
                    bot.memory.stopUpdating();
                }

                 // Disconnect viewer socket on end
                 if (activeBots[botId].viewerSocket) {
                     activeBots[botId].viewerSocket.disconnect();
                 }
                delete activeBots[botId].bot; // Remove bot instance on end
            }
            broadcastBotList();
        });

        // --- Add bot.viewer methods ---
        bot.viewer = {
            erase: (id) => {
                if (!activeBots[botId]) return;
                delete activeBots[botId].primitives[id];
                if (viewerSocket.connected) {
                    viewerSocket.emit('viewerData', { botId, payload: { type: 'primitive', data: { id } } }); // Send erase command
                }
            },
            drawBoxGrid: (id, start, end, color = 'aqua') => {
                 if (!activeBots[botId]) return;
                 const primitiveData = { type: 'boxgrid', id, start, end, color };
                 activeBots[botId].primitives[id] = primitiveData;
                 if (viewerSocket.connected) {
                    viewerSocket.emit('viewerData', { botId, payload: { type: 'primitive', data: primitiveData } });
                 }
            },
            drawLine: (id, points, color = 0xff0000) => {
                 if (!activeBots[botId]) return;
                 const primitiveData = { type: 'line', id, points, color };
                 activeBots[botId].primitives[id] = primitiveData;
                 if (viewerSocket.connected) {
                    viewerSocket.emit('viewerData', { botId, payload: { type: 'primitive', data: primitiveData } });
                 }
            },
            drawPoints: (id, points, color = 0xff0000, size = 5) => {
                 if (!activeBots[botId]) return;
                 const primitiveData = { type: 'points', id, points, color, size };
                 activeBots[botId].primitives[id] = primitiveData;
                 if (viewerSocket.connected) {
                    viewerSocket.emit('viewerData', { botId, payload: { type: 'primitive', data: primitiveData } });
                 }
            }
            // TODO: Add methods for other shapes if needed (spheres, paths etc.)
        };

        // --- Bot Death Listener for Threat Boost ---
        bot.on('death', () => {
            // This basic 'death' event doesn't provide the killer.
            // We might need to listen to 'entityGone' and correlate with recent damage,
            // or parse death messages in chat ('kicked' event might have some info sometimes).
            // This is complex and requires more sophisticated event handling or chat parsing.

            // Placeholder logic assuming we *could* get the killer entity/name
            console.log(`Bot ${botId} died. Checking for player kill boost...`);
            const killer = null; // = findKillerLogic(); // <<<< Needs implementation

            if (killer && killer.type === 'player' && !isManagedBot(killer.username)) { // Need isManagedBot helper or access
                const killedBotStrength = bot.memory?.getStrengthLevel() || 0; // Get last known strength

                // Calculate killer's threat at time of death (needs helpers from botMemory or duplication)
                // This is tricky because the killer entity might already be gone or changed state.
                // We'd ideally use the killer entity state *just before* the kill.
                // const killerThreatLevel = calculateThreatLevelForEntity(killer); // <<<< Needs implementation

                // Example placeholder calculation:
                const killerThreatLevel = 5; // Replace with actual calculation if possible

                console.log(`Killed by ${killer.username}. Bot Strength: ${killedBotStrength}, Killer Threat: ${killerThreatLevel}`);

                if (killerThreatLevel <= killedBotStrength) {
                    const boostToAdd = (killedBotStrength - killerThreatLevel) + 1;
                    console.log(`Applying threat boost of ${boostToAdd} to ${killer.username}`);
                    updatePlayerThreatBoost(killer.username, boostToAdd);
                }
            } else {
                 console.log(`Bot ${botId} death cause not identified as eligible player kill.`);
            }
        });
        // NOTE: Proper killer identification is the main challenge here.

    } catch (error) {
        console.error(`Failed to create bot ${botId}:`, error);
        if (activeBots[botId]) {
            activeBots[botId].status = `creation_failed: ${error.message}`;
            delete activeBots[botId].bot;
        }
        broadcastBotList();
    }
}

function deleteBot(botId) {
    console.log(`Attempting to delete bot ${botId}`);
    const botData = activeBots[botId];
    if (botData) {
        // Disconnect viewer socket first
        if (botData.viewerSocket) {
            console.log(`Disconnecting viewer socket for bot ${botId}`);
            botData.viewerSocket.disconnect();
        }
        // Quit the bot if it exists
        if (botData.bot) {
            unloadActivity(botData.bot, botData.activity); // Attempt to clean up activity
            botData.bot.quit();
        }
        // Clear defense interval on delete
        if (botData.defenseMonitorInterval) {
            clearInterval(botData.defenseMonitorInterval);
        }
        // Remove from our management
        delete activeBots[botId];
        console.log(`Bot ${botId} removed.`);
        broadcastBotList();
    } else {
        console.warn(`Bot ${botId} not found for deletion.`);
    }
}

function shutdownAllBots() {
    console.log('Shutting down all bots...');
    Object.keys(activeBots).forEach(botId => {
        deleteBot(botId);
    });
    stopBotDistanceUpdates(); // Stop distance updates on shutdown
    console.log('All bots shut down.');
}


// --- Activity Management ---
// Modified to accept options for the new activity
function changeActivity(botId, newActivityName, options = {}) {
    const botData = activeBots[botId];
    // Allow changing activity even if not idle, e.g., stopping combat
    if (!botData || !botData.bot) {
        console.warn(`Cannot change activity for bot ${botId}: Bot not found.`);
        return;
    }
    if (botData.status === 'connecting' || botData.status.startsWith('error') || botData.status.startsWith('kicked') || botData.status.startsWith('disconnected')) {
        console.warn(`Cannot change activity for bot ${botId}: Bot status is ${botData.status}.`);
        return;
    }

    // Unload current activity first
    if (botData.activity) {
        unloadActivity(botData.bot, botData.activity);
    }

    // Load new activity, passing options and the manager's botId
    loadActivity(botId, botData.bot, newActivityName, options); // Pass botId here
    botData.activity = newActivityName; // Update current activity name
    broadcastBotList(); // Update frontend with new activity
}

// Modified to accept managerBotId and pass options
function loadActivity(managerBotId, bot, activityName, options = {}) { // Added managerBotId param
    const botUsername = bot.username; // Keep for logging clarity
    const activityPath = path.join(activitiesDir, `${activityName}.js`);
    try {
        // Add managerBotId to options passed to the activity
        const activityOptions = { ...options, managerBotId: managerBotId };

        // Clear cache for dynamic loading/reloading
        delete require.cache[require.resolve(activityPath)];
        const activityModule = require(activityPath);
        if (activityModule.load && typeof activityModule.load === 'function') {
            console.log(`Loading activity "${activityName}" for bot ${botUsername} (ID: ${managerBotId}) with options:`, activityOptions);
            // Pass extended options (including managerBotId) to the activity's load function
            const intervalId = activityModule.load(bot, activityOptions); // Activity might return an interval ID
            if (intervalId && activeBots[managerBotId]) { // Use managerBotId for lookup
                 activeBots[managerBotId].activityInterval = intervalId; // Store interval if returned
            }
            // Update memory with the new activity name
            if (bot.memory) {
                bot.memory._setActivity(activityName);
            }
        } else {
            console.error(`Activity module ${activityName} does not have a valid load function for bot ${botUsername}.`);
            // Set memory activity to error if load fails structurally
            if (bot.memory) {
                bot.memory._setActivity('error:invalid_module');
            }
        }
    } catch (error) {
        console.error(`Failed to load activity "${activityName}" for bot ${botUsername} (ID: ${managerBotId}):`, error);
        // Potentially set bot status to error or revert activity
        if(activeBots[managerBotId]) { // Use managerBotId for lookup
            activeBots[managerBotId].status = `activity_error: ${activityName}`;
            activeBots[managerBotId].activity = 'error';
            // Update memory activity on load error
            if (bot.memory) {
                bot.memory._setActivity('error:load_failed');
            }
        }
    }
}

function unloadActivity(bot, activityName) {
     if (!activityName) return; // No activity to unload

    const botId = bot.username;
    const activityPath = path.join(activitiesDir, `${activityName}.js`);
    try {
        // Check if module exists before requiring
        if (fs.existsSync(activityPath)) {
            // Clear cache for dynamic loading/reloading
             delete require.cache[require.resolve(activityPath)];
            const activityModule = require(activityPath);

            // Clear any stored interval first
            if (activeBots[botId] && activeBots[botId].activityInterval) {
                console.log(`Clearing interval for activity "${activityName}" for bot ${botId}`);
                clearInterval(activeBots[botId].activityInterval);
                activeBots[botId].activityInterval = null;
            }

            if (activityModule.unload && typeof activityModule.unload === 'function') {
                console.log(`Unloading activity "${activityName}" for bot ${botId}`);
                activityModule.unload(bot);
            }
        } else {
             console.warn(`Activity module ${activityName} not found for unloading.`);
        }
    } catch (error) {
        console.error(`Failed to unload activity "${activityName}" for bot ${botId}:`, error);
         // Clear interval just in case unload failed but interval exists
         if (activeBots[botId] && activeBots[botId].activityInterval) {
            clearInterval(activeBots[botId].activityInterval);
            activeBots[botId].activityInterval = null;
         }
    } finally {
        // Ensure activity is marked as null even if unload fails
        if (activeBots[botId] && activeBots[botId].activity === activityName) {
             activeBots[botId].activity = null;
             // Also update memory
             if (bot.memory) {
                 bot.memory._setActivity(null); // Set to null when unloaded
             }
        }
    }
}


let availableActivities = [];
function getAvailableActivities() {
    try {
        const files = fs.readdirSync(activitiesDir);
        availableActivities = files
            .filter(file => file.endsWith('.js'))
            .map(file => path.basename(file, '.js'));
        console.log('Available activities:', availableActivities);
    } catch (error) {
        console.error('Failed to read activities directory:', error);
        availableActivities = [];
    }
    return availableActivities;
}

// --- Data Retrieval & Broadcasting ---
function getBotList() {
    // Return a serializable version of the bot list for the frontend
    return Object.entries(activeBots).map(([id, data]) => ({
        id: id,
        status: data.status,
        activity: data.activity,
        options: data.options // Send options back for context
    }));
}

function broadcastBotList() {
    if (broadcast) {
        broadcast({ type: 'botListUpdate', payload: getBotList() });
    }
}

// --- New function to set target coordinates ---
function setBotTargetCoordinates(botId, coords) {
    const botData = activeBots[botId];
    if (botData && botData.bot && botData.bot.memory) {
        try {
            // Ensure coords are numbers before creating Vec3
            const x = parseFloat(coords.x);
            const y = parseFloat(coords.y);
            const z = parseFloat(coords.z);
            if (isNaN(x) || isNaN(y) || isNaN(z)) {
                console.error(`Error setting target coordinates for ${botId}: Invalid coordinate values received`, coords);
                return;
            }
            const targetVec = new Vec3(x, y, z);
            botData.bot.memory.setTargetCoordinates(targetVec);
            console.log(`[BotManager] Set target coordinates for ${botId} to: ${targetVec}`);
            // Add log to check the value immediately after setting
            const checkCoords = botData.bot.memory.getTargetCoordinates();
            console.log(`[BotManager] Value in memory for ${botId} after set:`, checkCoords, `(Is Vec3: ${checkCoords instanceof Vec3})`);
            // Optionally, trigger an activity update if the bot is currently pathfinding
            // if (botData.activity === 'pathfind') {
            //     // Re-trigger or update the pathfind activity logic if needed
            // }
        } catch (error) {
            console.error(`Error setting target coordinates for ${botId}:`, error);
        }
    } else {
        console.warn(`Bot ${botId} not found or memory plugin not available.`);
    }
}

// --- New function to get nearby entities ---
function getNearbyEntities(botId, range = 32) { // Default range of 32 blocks
    const botData = activeBots[botId];
    if (!botData || !botData.bot || !botData.bot.entities) {
        console.warn(`Cannot get entities for bot ${botId}: Bot not found or entities not available.`);
        return [];
    }

    const botPos = botData.bot.entity.position;
    const nearby = [];

    for (const entityId in botData.bot.entities) {
        const entity = botData.bot.entities[entityId];
        if (entity === botData.bot.entity) continue; // Skip self
        if (entity.position.distanceTo(botPos) <= range) {
            nearby.push({
                id: entity.id, // Use entity.id if available, otherwise fallback might be needed
                username: entity.username, // May be undefined for mobs
                name: entity.name || entity.displayName, // Use name (mobs) or displayName (objects)
                type: entity.type, // 'player', 'mob', 'object'
                position: entity.position
            });
        }
    }
    // console.log(`Found ${nearby.length} entities near ${botId}`); // Debug log
    return nearby;
}

// --- New function to set combat target ID ---
function setBotCombatTarget(botId, targetId) {
    const botData = activeBots[botId];
    if (botData && botData.bot && botData.bot.memory) {
        try {
            // targetId can be string (username) or number (entity id)
            botData.bot.memory.setCombatTargetId(targetId);
            console.log(`[BotManager] Set combat target for ${botId} to ID: ${targetId}`);
            // Optionally notify the frontend or log confirmation
        } catch (error) {
            console.error(`Error setting combat target for ${botId}:`, error);
        }
    } else {
        console.warn(`Bot ${botId} not found or memory plugin not available for setting combat target.`);
    }
}


// --- Exports ---
module.exports = {
    init,
    createBot,
    deleteBot,
    changeActivity,
    getAvailableActivities,
    getBotList,
    shutdownAllBots,
    setBotTargetCoordinates,
    getNearbyEntities,
    setBotCombatTarget, // Export the new function
    // Export boost functions for potential external use/debugging if needed
    getPlayerThreatBoost,
    updatePlayerThreatBoost,
    isManagedBot // Export the new helper function
};
