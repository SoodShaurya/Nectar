const { Vec3 } = require('vec3');
const pathfinder = require('../../../pathfinder/dist/index.js'); // Adjust path as needed
const GoalBlock = pathfinder.goals?.GoalBlock;

const GROUP_UP_DISTANCE = 10; // Blocks - How close bots need to be to complete grouping
const UPDATE_INTERVAL = 1000; // ms - How often to update pathfinding goal

// Module-level storage for intervals and listeners to manage cleanup
let activityIntervals = {}; // { botId: intervalId }
let pathfinderListeners = {}; // { botId: { listenerName: function } }

// --- Helper Functions ---

function getTargetPosition(bot) {
    const botMemory = bot.memory;
    if (!botMemory) return null;

    const manager = bot.botManagerRef;
    if (!manager) return null;

    // If this bot is an ally, target is the requester's position
    const requesterUsername = botMemory.getGroupUpRequester();
    if (requesterUsername) {
        const requesterBot = manager.getBotById(requesterUsername); // Assumes botId is username for getBotById
        return requesterBot?.memory?.getCurrentPosition() || null;
    }

    // If this bot is the requester, target is the designated ally's position
    const targetAllyUsername = botMemory.getGroupUpTarget();
    if (targetAllyUsername) {
        const targetAllyBot = manager.getBotById(targetAllyUsername);
        return targetAllyBot?.memory?.getCurrentPosition() || null;
    }

    // If this bot is an ally but requester info is missing (shouldn't happen in normal flow)
    // Or if requester target info is missing
    console.warn(`[Activity GroupUp ${bot.username}] Could not determine target position.`);
    return null;
}

function cleanup(bot) {
    const botId = bot.username; // Assuming botId used is username

    // Clear interval
    if (activityIntervals[botId]) {
        clearInterval(activityIntervals[botId]);
        delete activityIntervals[botId];
    }

    // Cancel pathfinding
    if (bot.pathfinder && bot.pathfinder.isMoving()) {
        bot.pathfinder.cancel();
    }

    // Remove listeners
    const listeners = pathfinderListeners[botId];
    if (listeners) {
        if (listeners.goalAborted) bot.removeListener('goalAborted', listeners.goalAborted);
        if (listeners.resetPath) bot.removeListener('resetPath', listeners.resetPath);
        delete pathfinderListeners[botId];
    }

    // Clear memory flags
    if (bot.memory) {
        bot.memory.setGroupingUp(false);
        bot.memory.setGroupUpRequester(null);
        bot.memory.setGroupUpTarget(null);
        bot.memory.setGroupUpTargetCoords(null); // Clear coords too
    }

    console.log(`[Activity GroupUp ${botId}] Cleanup complete.`);
}

function handlePathfindingFailure(bot, reason) {
    const botId = bot.username;
    console.warn(`[Activity GroupUp ${botId}] Pathfinding failed or reset: ${reason}`);
    bot.chat(`Group up pathfinding failed: ${reason}`);
    cleanup(bot);

    // Revert to interrupted activity
    const interruptedActivity = bot.memory?.getInterruptedActivity() || 'stand_still';
    console.log(`[Activity GroupUp ${botId}] Reverting to activity: ${interruptedActivity}`);
    bot.botManagerRef?.changeActivity(botId, interruptedActivity); // Use manager ref to change activity
}

function completeGroupUp(bot) {
    const botId = bot.username;
    console.log(`[Activity GroupUp ${botId}] Group up successful (within ${GROUP_UP_DISTANCE} blocks).`);
    bot.chat('Grouped up!');
    cleanup(bot);

    // Revert to interrupted activity
    const interruptedActivity = bot.memory?.getInterruptedActivity() || 'stand_still';
    console.log(`[Activity GroupUp ${botId}] Reverting to activity: ${interruptedActivity}`);
    bot.botManagerRef?.changeActivity(botId, interruptedActivity); // Use manager ref to change activity
}


function startDynamicPathfinding(bot) {
    const botId = bot.username;

    // Clear previous listeners/intervals just in case
    cleanup(bot);
    pathfinderListeners[botId] = {}; // Re-initialize listener storage

    const intervalId = setInterval(() => {
        if (!bot.entity || !bot.memory || !bot.pathfinder) {
            console.warn(`[Activity GroupUp Interval ${botId}] Bot state invalid, stopping.`);
            cleanup(bot);
            return;
        }

        const targetPos = getTargetPosition(bot);
        if (!targetPos) {
            console.warn(`[Activity GroupUp Interval ${botId}] Could not get target position. Stopping group up.`);
            handlePathfindingFailure(bot, 'Target position unavailable');
            return;
        }

        const currentPos = bot.entity.position;
        const distance = currentPos.distanceTo(targetPos);

        // console.log(`[Activity GroupUp Interval ${botId}] Target: ${targetPos}, Current: ${currentPos}, Dist: ${distance.toFixed(1)}`); // Debug log

        if (distance < GROUP_UP_DISTANCE) {
            completeGroupUp(bot);
            return; // Stop interval processing
        }

        // Update goal
        if (GoalBlock) {
            const goal = new GoalBlock(targetPos.x, targetPos.y, targetPos.z);
            // console.log(`[Activity GroupUp Interval ${botId}] Setting new goal: ${goal.x}, ${goal.y}, ${goal.z}`); // Debug log
            bot.pathfinder.setGoal(goal, true); // Dynamic goal = true
        } else {
             console.error(`[Activity GroupUp Interval ${botId}] GoalBlock not available. Cannot set goal.`);
             handlePathfindingFailure(bot, 'Pathfinder GoalBlock missing');
        }

    }, UPDATE_INTERVAL);

    // Store interval ID
    activityIntervals[botId] = intervalId;

    // --- Attach Pathfinding Event Listeners ---
    const onGoalAborted = (goal) => handlePathfindingFailure(bot, 'Goal Aborted');
    const onResetPath = (reason) => handlePathfindingFailure(bot, `Path Reset (${reason})`);

    pathfinderListeners[botId].goalAborted = onGoalAborted;
    pathfinderListeners[botId].resetPath = onResetPath;

    bot.on('goalAborted', onGoalAborted);
    bot.on('resetPath', onResetPath);

    console.log(`[Activity GroupUp ${botId}] Dynamic pathfinding interval started.`);
    return intervalId; // Return interval ID so botManager can store/clear it if needed (though cleanup handles it)
}


// --- Activity Load/Unload ---

function load(bot, options = {}) {
    const botId = bot.username; // Use username as the key for simplicity
    const manager = bot.botManagerRef;
    console.log(`[Activity GroupUp ${botId}] Loading with options:`, options);

    // --- Basic Checks ---
    if (!bot.pathfinder || !bot.memory || !manager) {
        console.error(`[Activity GroupUp ${botId}] Error: Required plugins (pathfinder, memory) or manager reference not loaded.`);
        bot.chat('GroupUp activity cannot start: Missing requirements.');
        return null; // Indicate failure
    }
     if (!GoalBlock) {
        console.error(`[Activity GroupUp ${botId}] Error: Pathfinder GoalBlock class not found.`);
        bot.chat('GroupUp activity cannot start: Pathfinder goal missing.');
        return null;
    }

    // --- Determine Role (Requester or Ally) ---
    const isAlly = options.isAlly || false;
    const requesterUsername = options.requesterUsername || null;

    if (isAlly) {
        // --- Ally Logic ---
        if (!requesterUsername) {
             console.error(`[Activity GroupUp ${botId}] Error: Ally loaded without requesterUsername.`);
             bot.chat('GroupUp error: Missing requester info.');
             return null;
        }
        console.log(`[Activity GroupUp ${botId}] Loaded as Ally for ${requesterUsername}.`);
        bot.chat(`Grouping up with ${requesterUsername}!`);
        bot.memory.setGroupingUp(true);
        bot.memory.setGroupUpRequester(requesterUsername);
        // Target coords should have been set by the requester before this activity was loaded
        const targetCoords = bot.memory.getGroupUpTargetCoords();
        if (!targetCoords) {
             console.warn(`[Activity GroupUp ${botId}] Warning: Target coordinates not set by requester ${requesterUsername}. Attempting to get current position.`);
             // Fallback: try to get requester's current position directly (might be null)
             const requesterBot = manager.getBotById(requesterUsername);
             const fallbackPos = requesterBot?.memory?.getCurrentPosition();
             if (fallbackPos) {
                 bot.memory.setGroupUpTargetCoords(fallbackPos); // Set it for the first interval run
             } else {
                 console.error(`[Activity GroupUp ${botId}] Error: Cannot determine target coordinates for requester ${requesterUsername}. Aborting.`);
                 bot.chat(`GroupUp error: Cannot find ${requesterUsername}.`);
                 cleanup(bot); // Clean up flags set earlier
                 return null;
             }
        }

        return startDynamicPathfinding(bot);

    } else {
        // --- Requester Logic ---
        const requiredStrength = options.requiredStrength || 0;
        if (requiredStrength <= 0) {
             console.error(`[Activity GroupUp ${botId}] Error: Loaded as Requester with invalid requiredStrength: ${requiredStrength}`);
             return null;
        }
        console.log(`[Activity GroupUp ${botId}] Loaded as Requester. Required Strength: ${requiredStrength}`);
        bot.chat(`Need backup! Looking for allies... (Need Strength: ${requiredStrength})`);

        const currentStrength = bot.memory.getStrengthLevel();
        let strengthDeficit = requiredStrength - currentStrength;

        if (strengthDeficit <= 0) {
            console.log(`[Activity GroupUp ${botId}] Strength deficit is zero or negative (${strengthDeficit}). No allies needed.`);
            // Technically shouldn't happen if defense monitor logic is correct, but handle defensively.
            // Revert immediately.
            const interrupted = bot.memory.getInterruptedActivity() || 'stand_still';
            manager.changeActivity(botId, interrupted);
            return null;
        }

        // Find Allies
        const allBotIds = Object.keys(manager.activeBots || {}); // Get IDs from manager's internal store
        const botDistances = bot.memory.getBotDistances();
        const availableAllies = [];

        for (const otherBotId of allBotIds) {
            if (otherBotId === botId) continue; // Skip self

            const otherBotInstance = manager.getBotById(otherBotId);
            if (!otherBotInstance || !otherBotInstance.memory) continue; // Skip if bot instance/memory unavailable

            // Check if bot is suitable: not already grouping, not error/disconnected etc.
            const otherActivity = otherBotInstance.memory.getCurrentActivity();
            const otherStatus = manager.activeBots[otherBotId]?.status || 'unknown'; // Get status from manager store
            const isBusy = otherActivity === 'groupUp' || otherActivity === 'combat' || otherStatus !== 'idle'; // Define 'busy' criteria

            if (!isBusy && botDistances.hasOwnProperty(otherBotId)) {
                const strength = otherBotInstance.memory.getStrengthLevel();
                if (strength > 0) {
                    availableAllies.push({
                        id: otherBotId,
                        distance: botDistances[otherBotId],
                        strength: strength
                    });
                }
            }
        }

        // Sort by distance
        availableAllies.sort((a, b) => a.distance - b.distance);

        const selectedAllies = [];
        let gatheredStrength = 0;

        for (const ally of availableAllies) {
            if (strengthDeficit <= 0) break; // Met the requirement

            selectedAllies.push(ally);
            gatheredStrength += ally.strength;
            strengthDeficit -= ally.strength;
            console.log(`[Activity GroupUp ${botId}] Selected ally: ${ally.id} (Dist: ${ally.distance.toFixed(1)}, Str: ${ally.strength}). Deficit remaining: ${strengthDeficit}`);
        }

        if (strengthDeficit > 0) {
            console.warn(`[Activity GroupUp ${botId}] Could not find enough allies. Found ${selectedAllies.length} providing ${gatheredStrength} strength. Deficit remaining: ${strengthDeficit}. Aborting group up.`);
            bot.chat(`Couldn't find enough backup (${gatheredStrength}/${requiredStrength - currentStrength} needed).`);
            // Revert activity
            const interrupted = bot.memory.getInterruptedActivity() || 'stand_still';
            manager.changeActivity(botId, interrupted);
            return null;
        }

        // Request selected allies
        console.log(`[Activity GroupUp ${botId}] Requesting ${selectedAllies.length} allies: ${selectedAllies.map(a => a.id).join(', ')}`);
        bot.chat(`Calling for backup from: ${selectedAllies.map(a => a.id.split('@')[0]).join(', ')}!`); // Show usernames in chat

        const currentPosition = bot.entity.position; // Get requester's current position once

        for (const ally of selectedAllies) {
            const allyBot = manager.getBotById(ally.id);
            if (allyBot && allyBot.memory) {
                allyBot.memory.setGroupingUp(true);
                allyBot.memory.setGroupUpRequester(botId); // Set requester username/ID
                allyBot.memory.setGroupUpTargetCoords(currentPosition); // Set initial target coords
                // Store interrupted activity for the ally
                const allyCurrentActivity = allyBot.memory.getCurrentActivity();
                allyBot.memory.setInterruptedActivity(allyCurrentActivity || 'stand_still');
                // Change ally's activity
                manager.changeActivity(ally.id, 'groupUp', { isAlly: true, requesterUsername: botId });
            } else {
                 console.warn(`[Activity GroupUp ${botId}] Could not get bot instance or memory for selected ally ${ally.id} to send request.`);
                 // Note: This ally won't join, potentially causing issues if they were critical.
            }
        }

        // Set requester state and start pathfinding towards the *closest* selected ally
        const closestAlly = selectedAllies[0]; // Already sorted by distance
        bot.memory.setGroupingUp(true);
        bot.memory.setGroupUpTarget(closestAlly.id); // Set target ally username/ID

        return startDynamicPathfinding(bot);
    }
}

function unload(bot) {
    const botId = bot.username;
    console.log(`[Activity GroupUp ${botId}] Unloading...`);
    cleanup(bot); // Perform all cleanup tasks
    bot.clearControlStates(); // Good practice
}

module.exports = {
    load,
    unload
};
