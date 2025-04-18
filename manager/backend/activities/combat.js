// Removed incorrect Movements import
const { goals: { GoalFollow } } = require('../../../pathfinder/dist/index.js'); // Import GoalFollow for potential use

// Store listeners per bot { botId: { listenerName: function } }
let combatListeners = {};

function load(bot, options = {}) { // Options now includes managerBotId
    // Use managerBotId if available, otherwise fallback to username (less reliable)
    const managerBotId = options.managerBotId || bot.username;
    const botUsername = bot.username; // Keep for logging

    // Store managerBotId on the bot object for use in event handlers
    bot.managerBotId = managerBotId;

    console.log(`[Activity Combat ${botUsername}] Loading (Manager ID: ${managerBotId})...`);

    if (!bot.pathfinder || !bot.swordpvp || !bot.memory) {
        console.error(`[Activity Combat ${botUsername}] Error: Required plugins (pathfinder, swordpvp, memory) not loaded.`); // Use botUsername
        bot.chat('Combat activity requires pathfinder and swordpvp plugins.');
        return; // Stop loading if plugins aren't available
    }

    // Get target from memory
    const targetId = bot.memory.getCombatTargetId();

    if (targetId === null || targetId === undefined) {
        console.error(`[Activity Combat ${botUsername}] Error: No combat target ID set in bot memory.`); // Use botUsername
        bot.chat('Set my combat target first!');
        return;
    }

    console.log(`[Activity Combat ${botUsername}] Target ID from memory: ${targetId}`); // Use botUsername

    // --- Find Target ---
    let targetEntity = null;
    // Try finding by username first (players) - targetId might be username string
    if (typeof targetId === 'string' && bot.players[targetId]) {
        targetEntity = bot.players[targetId]?.entity;
    }
    // If not found by username, try by entity ID (mobs, objects) - targetId might be entity.id number
    if (!targetEntity && bot.entities[targetId]) {
         targetEntity = bot.entities[targetId];
    }
    // Fallback: Search by name/username if ID doesn't match (less reliable, but covers edge cases)
    if (!targetEntity && typeof targetId === 'string') {
        targetEntity = bot.nearestEntity(entity => (entity.username === targetId || entity.name === targetId || entity.displayName === targetId));
    }


    if (!targetEntity) {
        console.error(`[Activity Combat ${botUsername}] Error: Could not find target entity with ID/Name: ${targetId}`); // Use botUsername
        bot.chat(`Could not find target: ${targetId}`);
        return;
    }

    console.log(`[Activity Combat ${botUsername}] Found target: ${targetEntity.username || targetEntity.name} (ID: ${targetEntity.id})`); // Use botUsername

    // --- Configure Plugins ---
    // Pathfinder movements should be configured when the plugin is loaded globally or per-bot,
    // not typically within each activity that uses pathfinder. Rely on existing config.
    // const moves = new Movements(bot); // Removed incorrect instantiation
    // moves.allowFreeMotion = true;
    // moves.allowParkour = true;
    // moves.allowSprinting = true;
    // bot.pathfinder.setMovements(moves); // Removed - use existing movements

    // Configure Combat Options (can be extended via options later)
    bot.swordpvp.options.cps = 15; // Example CPS
    bot.swordpvp.options.critConfig.mode = 'hop'; // Example crit mode
    bot.swordpvp.options.critConfig.reaction.enabled = false;
    bot.swordpvp.options.rotateConfig.smooth = true;
    bot.swordpvp.options.strafeConfig.enabled = true; // Enable strafing if desired
    bot.swordpvp.options.strafeConfig.mode.mode = 'intelligent'
    bot.swordpvp.options.tapConfig.enabled = true
    bot.swordpvp.options.tapConfig.mode = 'wtap'
    // --- Setup Listeners ---
    unloadListeners(bot); // Clear any previous listeners for this bot
    // Store listeners using managerBotId as key
    combatListeners[managerBotId] = {};

    const onAttackedTarget = (target, reason, ticks) => {
        // console.log(`[Activity Combat ${botUsername}] Attacked ${target.username || target.name}. Reason: ${reason}, Next attack in: ${ticks} ticks`); // Use botUsername
        // Can add more logic here if needed
    };

    const onStoppedAttacking = () => {
        console.log(`[Activity Combat ${botUsername}] Stopped attacking.`); // Use botUsername
        bot.chat('Combat finished or stopped.');
        unloadListeners(bot); // Ensure listeners are cleaned up first

        // Clear target from memory
        if (bot.memory) {
            bot.memory.setCombatTargetId(null);
            console.log(`[Activity Combat ${botUsername}] Cleared combat target from memory.`); // Use botUsername
        }

        // Switch back to the interrupted activity using the attached manager reference and the correct managerBotId
        if (bot.botManagerRef && typeof bot.botManagerRef.changeActivity === 'function') {
            const activityToReturnTo = bot.memory?.getInterruptedActivity() || 'stand_still'; // Get stored activity, default to stand_still
            bot.memory?.setInterruptedActivity(null); // Clear the stored activity name

            console.log(`[Activity Combat ${botUsername}] Attempting to switch back to: ${activityToReturnTo}`);
            // Use setTimeout to avoid potential issues with changing activity directly within an event handler of the old activity
            setTimeout(() => {
                try {
                    // Use the attached reference, the stored managerBotId, and the retrieved activity name
                    bot.botManagerRef.changeActivity(bot.managerBotId, activityToReturnTo);
                } catch (error) {
                     console.error(`[Activity Combat ${botUsername}] Error switching activity back to ${activityToReturnTo}:`, error);
                }
            }, 50); // Small delay
        } else {
            console.error(`[Activity Combat ${botUsername}] Cannot switch activity: bot.botManagerRef or changeActivity function not found.`);
            // If manager isn't available, the bot might get stuck. Consider fallback?
        }
    };

    const onTargetBlockingUpdate = (target, blocking) => {
         console.log(`[Activity Combat ${botUsername}] Target ${target.username || target.name} blocking status: ${blocking}`); // Use botUsername
         // swordpvp handles axe switching automatically if configured/available
    };
    // Store listeners using managerBotId as key to avoid conflicts if multiple bots share username temporarily
    combatListeners[managerBotId] = {};
    combatListeners[managerBotId].attackedTarget = onAttackedTarget;
    combatListeners[managerBotId].stoppedAttacking = onStoppedAttacking;
    combatListeners[managerBotId].targetBlockingUpdate = onTargetBlockingUpdate;

    // Attach listeners using the swordpvp emitter
    bot.swordpvp.on('attackedTarget', combatListeners[managerBotId].attackedTarget);
    bot.swordpvp.once('stoppedAttacking', combatListeners[managerBotId].stoppedAttacking); // Use once if we want it to trigger unload
    bot.swordpvp.on('targetBlockingUpdate', combatListeners[managerBotId].targetBlockingUpdate);

    // --- Start Combat ---
    console.log(`[Activity Combat ${botUsername}] Starting sword attack on ${targetEntity.username || targetEntity.name}`);
    bot.chat(`Attacking ${targetEntity.username || targetEntity.name}!`);
    bot.swordpvp.attack(targetEntity);

    // No interval needed, combat is event-driven by the plugin
    return null;
}

function unloadListeners(bot) {
    const managerBotId = bot.managerBotId || bot.username; // Use stored ID or fallback
    const botUsername = bot.username;
    const listeners = combatListeners[managerBotId];
    if (listeners && bot.swordpvp) { // Check if swordpvp exists
        // Remove listeners from the swordpvp emitter
        if (listeners.attackedTarget) bot.swordpvp.removeListener('attackedTarget', listeners.attackedTarget);
        if (listeners.stoppedAttacking) bot.swordpvp.removeListener('stoppedAttacking', listeners.stoppedAttacking);
        if (listeners.targetBlockingUpdate) bot.swordpvp.removeListener('targetBlockingUpdate', listeners.targetBlockingUpdate);
        delete combatListeners[managerBotId]; // Delete using managerBotId
        // console.log(`[Activity Combat ${botUsername}] Unloaded combat listeners.`);
    }
}

function unload(bot) {
    const botUsername = bot.username;
    console.log(`[Activity Combat ${botUsername}] Unloading...`);

    // Stop combat plugin first
    if (bot.swordpvp) {
        bot.swordpvp.stop(); // This should trigger the 'stoppedAttacking' listener if running
    }

    // Stop pathfinder movement just in case
    if (bot.pathfinder) {
        // Use cancel() as seen in pathfind.js activity
        bot.pathfinder.cancel();
    }

    // Remove any listeners we might have attached
    unloadListeners(bot);

    // Clear controls (good practice)
    bot.clearControlStates();
}

module.exports = {
    load,
    unload
};
