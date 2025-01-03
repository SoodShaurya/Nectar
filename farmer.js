const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const fs = require('fs');
const { broadcastBotData } = require('./visualizer');

// Configuration
const RANGE = 32; // Search range for blocks
const DEBUG = true; // Debug flag
const reservedBlocks = new Map(); // Maps block positions to bot usernames
const reservedTrees = new Map(); // Maps tree base positions to bot usernames

// Block groups
const oreBlocks = [
    'diamond_ore', 'iron_ore', 'gold_ore', 'coal_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore',
    'deepslate_diamond_ore', 'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_coal_ore',
    'deepslate_emerald_ore', 'deepslate_lapis_ore', 'deepslate_redstone_ore', 'nether_quartz_ore',
    'nether_gold_ore', 'ancient_debris'
];

const treeLogBlocks = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log'
];

// Debug logging function
function debugLog(bot, message) {
    if (DEBUG) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${bot.username}] ${message}`);
    }
}

function isLog(block) {
    return treeLogBlocks.includes(block.name);
}

function isOre(block) {
    return oreBlocks.includes(block.name);
}

function getVisualizationData(bot) {
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
                        type: isLog(block) ? 'log' : (isOre(block) ? 'ore' : 'other')
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
function findTreeBase(bot, startBlock) {
    debugLog(bot, `Searching for tree base starting at ${startBlock.position}`);
    const visited = new Set();
    const queue = [startBlock.position];
    const treeBlocks = [];

    let currentPos = startBlock.position;
    while (true) {
        const blockBelow = bot.blockAt(currentPos.offset(0, -1, 0));
        const currentBlock = bot.blockAt(currentPos);
        
        if (!blockBelow || !isLog(currentBlock) || !isLog(blockBelow)) {
            break;
        }
        currentPos = currentPos.offset(0, -1, 0);
    }

    queue.length = 0;
    queue.push(currentPos);
    visited.clear();

    while (queue.length > 0) {
        const pos = queue.shift();
        const posKey = pos.toString();

        if (visited.has(posKey)) continue;
        visited.add(posKey);

        const block = bot.blockAt(pos);
        if (!block || !isLog(block)) continue;

        treeBlocks.push(pos);
        treeBlocks.sort((a, b) => a.y - b.y);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const newPos = pos.offset(dx, 0, dz);
                if (!visited.has(newPos.toString())) {
                    queue.push(newPos);
                }
            }
        }

        const blockAbove = pos.offset(0, 1, 0);
        if (!visited.has(blockAbove.toString())) {
            queue.push(blockAbove);
        }
    }

    return treeBlocks.length > 0 ? {
        basePosition: currentPos,
        blocks: treeBlocks
    } : null;
}

function findOreVein(bot, startBlock) {
    const visited = new Set();
    const queue = [startBlock.position];
    const veinBlocks = [];
    const targetType = startBlock.name;

    while (queue.length > 0) {
        const pos = queue.shift();
        const posKey = pos.toString();

        if (visited.has(posKey)) continue;
        visited.add(posKey);

        const block = bot.blockAt(pos);
        if (!block || block.name !== targetType) continue;

        veinBlocks.push(pos);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const newPos = pos.offset(dx, dy, dz);
                    if (!visited.has(newPos.toString())) {
                        queue.push(newPos);
                    }
                }
            }
        }
    }

    return veinBlocks.length > 0 ? {
        basePosition: startBlock.position,
        blocks: veinBlocks
    } : null;
}

async function mineBlock(bot, blockPos) {
    try {
        const block = bot.blockAt(blockPos);
        if (!block) {
            debugLog(bot, `No block found at ${blockPos}`);
            return false;
        }

        debugLog(bot, `Attempting to mine ${block.name} at ${blockPos}`);

        const distance = bot.entity.position.distanceTo(blockPos);
        if (distance > 4) {
            const goal = new GoalNear(blockPos.x, blockPos.y, blockPos.z, 2);
            try {
                await bot.pathfinder.goto(goal);
            } catch (pathError) {
                debugLog(bot, `Pathfinding failed: ${pathError.message}`);
                return false;
            }
        }

        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool) {
            await bot.equip(tool, 'hand');
        }


        if (!bot.canDigBlock(block)) {
            debugLog(bot, `Cannot mine block at ${blockPos}`);
            return false;
        }

        bot.lookAt(blockPos.offset(0.5, 0.5, 0.5));

        await Promise.race([
            bot.dig(block, 'ignore', 'raycast'),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Mining timeout')), 10000)
            )
        ]);

        

        return true;
    } catch (err) {
        debugLog(bot, `Mining error at ${blockPos}: ${err.message}`);
        return false;
    }
}
async function mineStructure(bot, structure, isTree) {
    if (!structure || !structure.blocks || structure.blocks.length === 0) {
        debugLog(bot, 'Invalid structure provided for mining');
        return;
    }

    try {
        debugLog(bot, `Starting to mine ${isTree ? 'tree' : 'ore'} at ${structure.basePosition}`);
        let successfulMines = 0;
        const totalBlocks = structure.blocks.length;
        
        const blocksToMine = [...structure.blocks];
        if (isTree) {
            blocksToMine.sort((a, b) => a.y - b.y);
        }

        for (const blockPos of blocksToMine) {
            if (!bot.isMining) break;
            
            const block = bot.blockAt(blockPos);
            if (!block) continue;

            if ((isTree && !isLog(block)) || (!isTree && !isOre(block))) {
                continue;
            }

            const success = await mineBlock(bot, blockPos);
            if (success) {
                successfulMines++;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }

        debugLog(bot, `Mining structure completed. Success: ${successfulMines}/${totalBlocks}`);
    } catch (err) {
        debugLog(bot, `Error while mining structure: ${err.message}`);
    } finally {
        releaseStructure(structure.basePosition, isTree);
    }
}

function findNearestUnreservedStructure(bot, isTree = false) {
    const blocks = bot.findBlocks({
        matching: isTree ? isLog : isOre,
        maxDistance: RANGE,
        count: 64
    });

    for (const blockPos of blocks) {
        const block = bot.blockAt(blockPos);
        if (!block) continue;

        const structure = isTree ? findTreeBase(bot, block) : findOreVein(bot, block);
        if (!structure) continue;

        const map = isTree ? reservedTrees : reservedBlocks;
        if (!map.has(structure.basePosition.toString())) {
            return structure;
        }
    }

    return null;
}

async function createBot(username, password) {
    const bot = mineflayer.createBot({
        host: '159.54.167.2',
        port: 25567,
        username: username,
        password: password,
        auth: 'microsoft',
        version: '1.21.1'
    });

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
        const defaultMove = new Movements(bot);
        defaultMove.canDig = true;
        bot.pathfinder.setMovements(defaultMove);
        debugLog(bot, 'Spawned and ready');
    });

    bot.on('physicsTick', () => {
        broadcastBotData(getVisualizationData(bot));
    });

    bot.on('chat', async (username, message) => {
        const command = message.toLowerCase();
        
        if (command === 'mine trees' || command === 'mine ores') {
            const isTree = command === 'mine trees';
            bot.chat(`Starting to mine ${isTree ? 'trees' : 'ores'}`);
            bot.isMining = true;
            bot.miningType = isTree ? 'trees' : 'ores';

            while (bot.isMining) {
                try {
                    const structure = findNearestUnreservedStructure(bot, isTree);
                    
                    if (!structure) {
                        bot.chat(`No unreserved ${isTree ? 'trees' : 'ores'} found nearby`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        continue;
                    }

                    await mineStructure(bot, structure, isTree);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (err) {
                    debugLog(bot, `Error in mining loop: ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        if (command === 'stop mining') {
            bot.isMining = false;
            bot.chat('Stopping mining operation');
        }
    });

    return bot;
}

async function initializeBots() {
    try {
        const fileContents = fs.readFileSync('accs.txt', 'utf8');
        const accounts = fileContents.trim().split('\n');
        
        const bots = [];
        
        for (const account of accounts) {
            const [username, password] = account.trim().split(':');
            try {
                console.log(`Creating bot for ${username}`);
                const bot = await createBot(username, password);
                bots.push(bot);
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (err) {
                console.error(`Failed to create bot for ${username}:`, err);
            }
        }
        
        console.log(`Successfully loaded ${bots.length} bots`);
        return bots;
    } catch (err) {
        console.error('Error reading accounts file:', err);
        return [];
    }
}

// Start the bots
initializeBots().catch(console.error);