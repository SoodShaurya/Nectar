const Vec3 = require('vec3');
const { parentPort } = require('worker_threads');

// Block groups
const oreBlocks = new Set([
    'diamond_ore', 'iron_ore', 'gold_ore', 'coal_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore',
    'deepslate_diamond_ore', 'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_coal_ore',
    'deepslate_emerald_ore', 'deepslate_lapis_ore', 'deepslate_redstone_ore', 'nether_quartz_ore',
    'nether_gold_ore', 'ancient_debris'
]);

const treeLogBlocks = new Set([
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log'
]);

class Utils {
    constructor() {
        this.RANGE = 32;
        this.DEBUG = true;
    }

    isLog(block) {
        if (!block) return false;
        return treeLogBlocks.has(block.name);
    }

    isOre(block) {
        return block && oreBlocks.has(block.name);
    }

    debugLog(botName, message) {
        if (this.DEBUG && parentPort) {
            parentPort.postMessage({
                type: 'status',
                data: `[${botName}] ${message}`
            });
        }
    }

    getVisualizationData(bot) {
        const blocks = [];
        const botPos = bot.entity.position;

        // Scan surrounding blocks
        for (let x = -8; x < 8; x++) {
            for (let z = -8; z < 8; z++) {
                for (let y = -8; y < 8; y++) {
                    const block = bot.blockAt(botPos.offset(x, y, z));
                    if (block && block.name !== 'air') {
                        blocks.push({
                            relativeX: x,
                            relativeZ: z,
                            y: block.position.y,
                            type: this.isLog(block) ? 'log' : (this.isOre(block) ? 'ore' : 'other')
                        });
                    }
                }
            }
        }

        return {
            botName: bot.username,
            botY: botPos.y,
            blocks: blocks,
            path: bot.pathfinder.path?.map(node => ({
                relativeX: node.x - botPos.x,
                relativeZ: node.z - botPos.z
            })),
            goal: bot.pathfinder.goal ? {
                relativeX: bot.pathfinder.goal.x - botPos.x,
                relativeZ: bot.pathfinder.goal.z - botPos.z
            } : null
        };
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new Utils();