const { Vec3 } = require('vec3');
const { goals } = require('../../../pathfinder/dist/index.js'); // Corrected relative path (up three levels)

let pathfinderListeners = {}; // Store listeners per bot { botId: { listenerName: function } }

function load(bot) {
    const botId = bot.username; // Or a more unique ID if available
    console.log(`[Activity Pathfind ${botId}] Loading...`);

    if (!bot.pathfinder) {
        console.error(`[Activity Pathfind ${botId}] Error: mineflayer-pathfinder plugin is not loaded.`);
        bot.chat('Pathfinder plugin not loaded. Cannot execute pathfind activity.');
        // Optionally set bot status to error
        return; // Stop loading if pathfinder isn't available
    }

    // Clear any previous listeners for this bot
    unloadListeners(bot);
    pathfinderListeners[botId] = {};

    const targetCoords = bot.memory.getTargetCoordinates();
    // Add log to check the value when the activity loads
    console.log(`[Activity Pathfind ${botId}] Read target coordinates from memory:`, targetCoords, `(Is Vec3: ${targetCoords instanceof Vec3})`);

    if (targetCoords instanceof Vec3) {
        console.log(`[Activity Pathfind ${botId}] Target is valid Vec3: ${targetCoords}. Starting pathfinding.`);
        bot.chat(`Pathfinding to ${targetCoords.toString()}...`);

        // Access the required goals object directly
        // const goals = bot.pathfinder.goals; // This was incorrect
        if (!goals || !goals.GoalBlock) { // Check if the required goals object is valid
             console.error(`[Activity Pathfind ${botId}] Error: Could not load pathfinder goals object.`);
             bot.chat('Error loading pathfinder goals.');
             return;
        }

        const goal = new goals.GoalBlock(targetCoords.x, targetCoords.y, targetCoords.z);

        // Define listeners before calling goto
        const onGoalReached = () => {
            console.log(`[Activity Pathfind ${botId}] Goal reached: ${targetCoords}`);
            bot.chat('Target reached.');
            bot.memory.setTargetCoordinates(null); // Clear target on success
            unloadListeners(bot); // Clean up listeners
            // Optionally switch back to a default activity like 'stand_still'
            // require('../botManager').changeActivity(botId, 'stand_still');
        };

        const onPathError = (err) => {
            console.error(`[Activity Pathfind ${botId}] Pathfinding error:`, err);
            bot.chat(`Pathfinding error: ${err.message || err}`);
            // Don't clear target on error, user might want to retry
            unloadListeners(bot); // Clean up listeners
        };

        const onPathReset = (reason) => {
            console.log(`[Activity Pathfind ${botId}] Path reset: ${reason}. Pathfinding stopped.`);
            bot.chat(`Pathfinding interrupted: ${reason}`);
             // Don't clear target, interruption might be temporary
            unloadListeners(bot); // Clean up listeners
        };

        // Store listeners
        pathfinderListeners[botId].goalFinished = onGoalReached;
        pathfinderListeners[botId].goalAborted = onPathError; // Treat abort as error for now
        pathfinderListeners[botId].resetPath = onPathReset;

        // Attach listeners to the main bot object
        bot.once('goalFinished', pathfinderListeners[botId].goalFinished);
        bot.once('goalAborted', pathfinderListeners[botId].goalAborted);
        bot.once('resetPath', pathfinderListeners[botId].resetPath); // Listen for resets (e.g., block updates)

        // Start pathfinding
        bot.pathfinder.goto(goal).catch(err => {
            // This catch block handles immediate errors from the goto call itself
            // (e.g., invalid goal), distinct from async pathfinding errors.
            if (!pathfinderListeners[botId]?.goalAborted) {
                 // Avoid double logging if goalAborted listener already caught it
                 console.error(`[Activity Pathfind ${botId}] Immediate goto error:`, err);
                 bot.chat(`Pathfinding initiation error: ${err.message || err}`);
            }
            unloadListeners(bot); // Clean up on immediate error too
        });

    } else {
        console.log(`[Activity Pathfind ${botId}] No target coordinates set in memory.`);
        console.log(`[Activity Pathfind ${botId}] Target is NOT a valid Vec3 or is null.`); // Moved log here
        bot.chat('Set my target coordinates first!');
        // Optionally switch back to a default activity
        // require('../botManager').changeActivity(botId, 'stand_still');
    }
    // Removed the duplicate 'else' block

    // No interval needed for this activity, it's event-driven by pathfinder
    return null;
}

function unloadListeners(bot) {
    const botId = bot.username;
    const listeners = pathfinderListeners[botId];
    if (listeners) {
        // Remove listeners from the main bot object
        if (listeners.goalFinished) bot.removeListener('goalFinished', listeners.goalFinished);
        if (listeners.goalAborted) bot.removeListener('goalAborted', listeners.goalAborted);
        if (listeners.resetPath) bot.removeListener('resetPath', listeners.resetPath);
        delete pathfinderListeners[botId];
        // console.log(`[Activity Pathfind ${botId}] Unloaded pathfinder listeners.`);
    }
}


function unload(bot) {
    const botId = bot.username;
    console.log(`[Activity Pathfind ${botId}] Unloading...`);

    // Stop any ongoing pathfinding
    if (bot.pathfinder) {
        bot.pathfinder.cancel(); // Use cancel() which should trigger abort/reset listeners if pathing
    }

    // Remove any listeners we might have attached
    unloadListeners(bot);

    // Clear controls (good practice after stopping movement)
    bot.clearControlStates();
}

module.exports = {
    load,
    unload
};
