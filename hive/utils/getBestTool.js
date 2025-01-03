const nbt = require('prismarine-nbt');
const Vec3 = require('vec3').Vec3;


function getBestTool(bot, block) {
    const availableTools = bot.inventory.items();
    const effects = bot.entity.effects;
    let fastest = block.digTime(null, false, false, false, [], effects);
    let bestTool = null;
    for (const tool of availableTools) {
        const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : [];
        const speed = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects);
        if (speed < fastest) {
            fastest = speed;
            bestTool = tool;
        }
    }
    return bestTool;
}


module.exports = getBestTool;
