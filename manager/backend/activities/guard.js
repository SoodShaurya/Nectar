// Import the whole pathfinder module first
const pathfinder = require('../../../pathfinder/dist/index.js'); // Adjust path as needed
// Then access the GoalFollowEntity class (Corrected name)
const GoalFollowEntity = pathfinder.goals?.GoalFollowEntity; // Use optional chaining just in case 'goals' is undefined

function load(bot, options = {}) {
    const botUsername = bot.username;
    console.log(`[Activity Guard ${botUsername}] Loading...`);

    if (!bot.pathfinder || !bot.memory) {
        console.error(`[Activity Guard ${botUsername}] Error: Required plugins (pathfinder, memory) not loaded.`);
        bot.chat('Guard activity requires pathfinder and memory plugins.');
        return;
    }

    // Get target from memory (set by botManager before calling changeActivity)
    const targetId = bot.memory.getGuardTargetId();

    if (targetId === null || targetId === undefined) {
        console.error(`[Activity Guard ${botUsername}] Error: No guard target ID set in bot memory.`);
        bot.chat('Set my guard target first!');
        // Optionally switch back to a default activity like stand_still
        // bot.botManagerRef?.changeActivity(bot.managerBotId, 'stand_still');
        return;
    }

    console.log(`[Activity Guard ${botUsername}] Raw Target ID from memory: ${targetId}`);

    // --- Extract Username/ID and Find Target Entity ---
    let targetLookupId = targetId; // Use the raw ID by default (for entity IDs)
    let targetUsername = null;

    // If targetId is a string like "username@host:port", extract the username
    if (typeof targetId === 'string' && targetId.includes('@')) {
        targetUsername = targetId.split('@')[0];
        targetLookupId = targetUsername; // Use username for lookups
        console.log(`[Activity Guard ${botUsername}] Extracted username: ${targetUsername}`);
    }

    let targetEntity = null;
    // Try finding by username first (players) using extracted username if available
    if (targetUsername && bot.players[targetUsername]) {
        targetEntity = bot.players[targetUsername]?.entity;
    }
    // If not found by username, try by entity ID (using original targetId if it was numeric, or extracted username otherwise)
    if (!targetEntity && bot.entities[targetLookupId]) {
         targetEntity = bot.entities[targetLookupId];
    }
     // Fallback: Search by name/username using extracted username if available
     if (!targetEntity && targetUsername) {
        targetEntity = bot.nearestEntity(entity => (entity.username === targetUsername || entity.name === targetUsername || entity.displayName === targetUsername));
    }
     // Final fallback: Search using the original targetId if it wasn't a username match initially
     if (!targetEntity && typeof targetId === 'string' && targetId !== targetUsername) {
         targetEntity = bot.nearestEntity(entity => (entity.username === targetId || entity.name === targetId || entity.displayName === targetId));
     }


    if (!targetEntity) {
        console.error(`[Activity Guard ${botUsername}] Error: Could not find target entity using ID/Name: ${targetId} (Lookup ID: ${targetLookupId})`);
        bot.chat(`Could not find guard target: ${targetId}`);
        // Clear the invalid target from memory
        bot.memory.setGuardTargetId(null);
        // Optionally switch back to a default activity
        // bot.botManagerRef?.changeActivity(bot.managerBotId, 'stand_still');
        return;
    }

    const targetName = targetEntity.username || targetEntity.name || `Entity ${targetEntity.id}`;
    console.log(`[Activity Guard ${botUsername}] Found target: ${targetName}`);

    // --- Create and Set Goal ---
    // Check if GoalFollowEntity was successfully imported before using it
    if (!GoalFollowEntity) {
        console.error(`[Activity Guard ${botUsername}] Error: GoalFollowEntity class not found in pathfinder module. Check pathfinder build/exports.`);
        bot.chat('Error: Guard activity cannot find GoalFollowEntity.');
         // Clear the target from memory as we cannot proceed
         bot.memory.setGuardTargetId(null);
        return; // Stop loading the activity
    }

    const followRange = 10; // As requested
    // Use the correct class name here
    const goal = GoalFollowEntity.fromEntity(targetEntity, followRange, { dynamic: true, neverfinish: true });

    console.log(`[Activity Guard ${botUsername}] Setting GoalFollowEntity for ${targetName} with range ${followRange}`);
    bot.chat(`Guarding ${targetName}.`);
    // Use goto instead of setGoal
    bot.pathfinder.goto(goal); // goto handles the pathfinding execution

    // No interval needed, pathfinder handles movement based on the goal
    return null;
}

function unload(bot) {
    const botUsername = bot.username;
    console.log(`[Activity Guard ${botUsername}] Unloading...`);

    // Stop pathfinder movement
    if (bot.pathfinder) {
        // Use cancel() instead of stop()
        bot.pathfinder.cancel();
    }

    // Clear guard target from memory
    if (bot.memory) {
        bot.memory.setGuardTargetId(null);
        console.log(`[Activity Guard ${botUsername}] Cleared guard target from memory.`);
    }

    // Clear controls (good practice)
    bot.clearControlStates();
}

module.exports = {
    load,
    unload
};
