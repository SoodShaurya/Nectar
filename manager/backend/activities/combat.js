// Removed incorrect Movements import
const { goals: { GoalFollow } } = require('../../../pathfinder/dist/index.js'); // Import GoalFollow for potential use

// Store listeners per bot { botId: { listenerName: function } }
let combatListeners = {};

function load(bot, options = {}) { // Keep options param for potential future use, but don't rely on it for targetId
    const botId = bot.username; // Or a more unique ID if available

    console.log(`[Activity Combat ${botId}] Loading...`); // Removed options from log

    if (!bot.pathfinder || !bot.swordpvp || !bot.memory) {
        console.error(`[Activity Combat ${botId}] Error: Required plugins (pathfinder, swordpvp, memory) not loaded.`);
        bot.chat('Combat activity requires pathfinder and swordpvp plugins.');
        return; // Stop loading if plugins aren't available
    }

    // Get target from memory
    const targetId = bot.memory.getCombatTargetId();

    if (targetId === null || targetId === undefined) {
        console.error(`[Activity Combat ${botId}] Error: No combat target ID set in bot memory.`);
        bot.chat('Set my combat target first!');
        return;
    }

    console.log(`[Activity Combat ${botId}] Target ID from memory: ${targetId}`);

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
        console.error(`[Activity Combat ${botId}] Error: Could not find target entity with ID/Name: ${targetId}`);
        bot.chat(`Could not find target: ${targetId}`);
        return;
    }

    console.log(`[Activity Combat ${botId}] Found target: ${targetEntity.username || targetEntity.name} (ID: ${targetEntity.id})`);

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
    combatListeners[botId] = {};

    const onAttackedTarget = (target, reason, ticks) => {
        // console.log(`[Activity Combat ${botId}] Attacked ${target.username || target.name}. Reason: ${reason}, Next attack in: ${ticks} ticks`);
        // Can add more logic here if needed
    };

    const onStoppedAttacking = () => {
        console.log(`[Activity Combat ${botId}] Stopped attacking.`);
        bot.chat('Combat finished or stopped.');
        unloadListeners(bot);
        // Optionally switch back to idle? Depends on desired behavior.
        // require('../botManager').changeActivity(botId, 'stand_still');
    };

    const onTargetBlockingUpdate = (target, blocking) => {
         console.log(`[Activity Combat ${botId}] Target ${target.username || target.name} blocking status: ${blocking}`);
         // swordpvp handles axe switching automatically if configured/available
    };

    // Store listeners
    combatListeners[botId].attackedTarget = onAttackedTarget;
    combatListeners[botId].stoppedAttacking = onStoppedAttacking;
    combatListeners[botId].targetBlockingUpdate = onTargetBlockingUpdate;

    // Attach listeners using the swordpvp emitter
    bot.swordpvp.on('attackedTarget', combatListeners[botId].attackedTarget);
    bot.swordpvp.once('stoppedAttacking', combatListeners[botId].stoppedAttacking); // Use once if we want it to trigger unload
    bot.swordpvp.on('targetBlockingUpdate', combatListeners[botId].targetBlockingUpdate);

    // --- Start Combat ---
    console.log(`[Activity Combat ${botId}] Starting sword attack on ${targetEntity.username || targetEntity.name}`);
    bot.chat(`Attacking ${targetEntity.username || targetEntity.name}!`);
    bot.swordpvp.attack(targetEntity);

    // No interval needed, combat is event-driven by the plugin
    return null;
}

function unloadListeners(bot) {
    const botId = bot.username;
    const listeners = combatListeners[botId];
    if (listeners && bot.swordpvp) { // Check if swordpvp exists
        // Remove listeners from the swordpvp emitter
        if (listeners.attackedTarget) bot.swordpvp.removeListener('attackedTarget', listeners.attackedTarget);
        if (listeners.stoppedAttacking) bot.swordpvp.removeListener('stoppedAttacking', listeners.stoppedAttacking);
        if (listeners.targetBlockingUpdate) bot.swordpvp.removeListener('targetBlockingUpdate', listeners.targetBlockingUpdate);
        delete combatListeners[botId];
        // console.log(`[Activity Combat ${botId}] Unloaded combat listeners.`);
    }
}

function unload(bot) {
    const botId = bot.username;
    console.log(`[Activity Combat ${botId}] Unloading...`);

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
