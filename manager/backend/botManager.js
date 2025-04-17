const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client'); // Added for viewer connection

// Define default view distance, can be made configurable later
const VIEW_DISTANCE = 6;

let activeBots = {}; // Store bot instances and data: { botId: { bot: instance, status: '...', activity: '...', options: {...}, viewerSocket: socketInstance, primitives: {} } }
let broadcast; // Function to send messages to all clients

const activitiesDir = path.join(__dirname, 'activities');

// --- Initialization ---
function init(broadcastFunction) {
    broadcast = broadcastFunction;
    console.log('Bot Manager Initialized.');
    // Load available activities on startup
    getAvailableActivities();
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
        activityInterval: null,
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
            plugins: {
                // Add any essential plugins if needed later
            }
        });

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
            activeBots[botId].status = 'idle';
            sendViewerPosition(); // Send initial position to viewer
            // Load default activity after spawn
            changeActivity(botId, 'stand_still'); // Default activity
            broadcastBotList();
        });

        bot.on('error', (err) => {
            console.error(`Bot ${botId} error:`, err);
            if (activeBots[botId]) {
                 activeBots[botId].status = `error: ${err.message}`;
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                 activeBots[botId].activity = 'error';
                 // Disconnect viewer socket on error
                 if (activeBots[botId].viewerSocket) {
                     activeBots[botId].viewerSocket.disconnect();
                 }
            }
            broadcastBotList();
        });

        bot.on('kicked', (reason) => {
            console.log(`Bot ${botId} kicked for:`, reason);
             if (activeBots[botId]) {
                activeBots[botId].status = `kicked: ${reason}`;
                if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                activeBots[botId].activity = 'kicked';
                 // Disconnect viewer socket on kick
                 if (activeBots[botId].viewerSocket) {
                     activeBots[botId].viewerSocket.disconnect();
                 }
                delete activeBots[botId].bot;
             }
            broadcastBotList();
        });

        bot.once('end', (reason) => {
            console.log(`Bot ${botId} disconnected. Reason: ${reason}`);
            // Remove the 'move' listener specific to this bot instance
            bot.removeListener('move', sendViewerPosition);
            if (activeBots[botId]) {
                activeBots[botId].status = `disconnected: ${reason}`;
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                activeBots[botId].activity = 'disconnected';
                 // Disconnect viewer socket on end
                 if (activeBots[botId].viewerSocket) {
                     activeBots[botId].viewerSocket.disconnect();
                 }
                delete activeBots[botId].bot;
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
    console.log('All bots shut down.');
}


// --- Activity Management ---
function changeActivity(botId, newActivityName) {
    const botData = activeBots[botId];
    if (!botData || !botData.bot || botData.status !== 'idle') {
        console.warn(`Cannot change activity for bot ${botId}: Not ready or not found.`);
        return;
    }

    // Unload current activity first
    if (botData.activity) {
        unloadActivity(botData.bot, botData.activity);
    }

    // Load new activity
    loadActivity(botData.bot, newActivityName);
    botData.activity = newActivityName; // Update current activity name
    broadcastBotList(); // Update frontend with new activity
}

function loadActivity(bot, activityName) {
    const botId = bot.username; // Assuming username is part of botId logic
    const activityPath = path.join(activitiesDir, `${activityName}.js`);
    try {
        // Clear cache for dynamic loading/reloading
        delete require.cache[require.resolve(activityPath)];
        const activityModule = require(activityPath);
        if (activityModule.load && typeof activityModule.load === 'function') {
            console.log(`Loading activity "${activityName}" for bot ${botId}`);
            const intervalId = activityModule.load(bot); // Activity might return an interval ID
            if (intervalId && activeBots[botId]) {
                 activeBots[botId].activityInterval = intervalId; // Store interval if returned
            }
        } else {
            console.error(`Activity module ${activityName} does not have a valid load function.`);
        }
    } catch (error) {
        console.error(`Failed to load activity "${activityName}" for bot ${botId}:`, error);
        // Potentially set bot status to error or revert activity
        if(activeBots[botId]) {
            activeBots[botId].status = `activity_error: ${activityName}`;
            activeBots[botId].activity = 'error';
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

// --- Exports ---
module.exports = {
    init,
    createBot,
    deleteBot,
    changeActivity,
    getAvailableActivities,
    getBotList,
    shutdownAllBots
};
