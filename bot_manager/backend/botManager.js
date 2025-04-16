const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

let activeBots = {}; // Store bot instances and data: { botId: { bot: instance, status: '...', activity: '...', options: {...} } }
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
    activeBots[botId] = { bot: null, status: 'connecting', activity: null, options: options, activityInterval: null }; // Store initial state
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

        // --- Bot Event Listeners ---
        bot.once('spawn', () => {
            console.log(`Bot ${botId} spawned.`);
            activeBots[botId].status = 'idle';
            // Load default activity after spawn
            changeActivity(botId, 'stand_still'); // Default activity
            broadcastBotList();
        });

        bot.on('error', (err) => {
            console.error(`Bot ${botId} error:`, err);
            if (activeBots[botId]) {
                 activeBots[botId].status = `error: ${err.message}`;
                 // Maybe try to unload activity? Risky if bot state is bad.
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                 activeBots[botId].activity = 'error'; // Indicate activity stopped due to error
            }
            // Don't delete immediately, let user decide via frontend
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
                delete activeBots[botId].bot; // Remove bot instance
             }
            // Don't delete immediately, let user decide via frontend
            broadcastBotList();
        });

        bot.once('end', (reason) => {
            console.log(`Bot ${botId} disconnected. Reason: ${reason}`);
            if (activeBots[botId]) { // Check if it wasn't deleted manually first
                activeBots[botId].status = `disconnected: ${reason}`;
                 if (activeBots[botId].activityInterval) {
                    clearInterval(activeBots[botId].activityInterval);
                    activeBots[botId].activityInterval = null;
                 }
                activeBots[botId].activity = 'disconnected';
                delete activeBots[botId].bot; // Remove bot instance
                // Consider automatic removal after a delay or keep for manual cleanup
                // For now, keep the entry but mark as disconnected
            }
            broadcastBotList();
        });

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
        if (botData.bot) {
            unloadActivity(botData.bot, botData.activity); // Attempt to clean up activity
            botData.bot.quit();
        }
        delete activeBots[botId]; // Remove from our management
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
