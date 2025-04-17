const REPORT_INTERVAL = 5000; // ms - How often to report memory contents

let intervalId = null;

function reportMemory(bot) {
    if (!bot.memory) {
        console.warn(`[report_memory] Bot ${bot.username} does not have memory plugin loaded.`);
        // Optionally clear interval if memory is missing? Or just let it keep trying.
        return;
    }

    const nearbyEntities = bot.memory.getNearbyEntities();
    const entityIds = Object.keys(nearbyEntities);
    const count = entityIds.length;

    if (count === 0) {
        bot.chat("Memory Report: 0 entities nearby.");
        return;
    }

    const countsByType = {};
    for (const id of entityIds) {
        const entityData = nearbyEntities[id];
        const type = entityData.type || 'unknown'; // Use 'unknown' if type is missing
        countsByType[type] = (countsByType[type] || 0) + 1;
    }

    let summary = `Memory Report: ${count} entities nearby (`;
    summary += Object.entries(countsByType)
        .map(([type, num]) => `${type}: ${num}`)
        .join(', ');
    summary += ")";

    bot.chat(summary);
}

function load(bot) {
    console.log(`[report_memory] Loading for bot ${bot.username}`);
    if (intervalId) {
        clearInterval(intervalId); // Clear previous interval if any (shouldn't happen with manager logic, but safe)
    }
    // Initial report delayed slightly to allow memory to populate first time
    setTimeout(() => reportMemory(bot), 1000);
    intervalId = setInterval(() => reportMemory(bot), REPORT_INTERVAL);
    return intervalId; // Return the interval ID so botManager can clear it
}

function unload(bot) {
    console.log(`[report_memory] Unloading for bot ${bot.username}`);
    // Interval clearing is handled by botManager using the returned ID from load()
    // No specific cleanup needed here unless the activity created other resources.
}

module.exports = {
    load,
    unload
};
