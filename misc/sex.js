const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

const bot = mineflayer.createBot({
    host: '159.54.167.2',
    port: 25567,
    username: 'poghacking11@outlook.com',
    password: 'bmKKJc!Hp8PC',
    auth: 'microsoft',
    version: '1.21.1'
});

bot.loadPlugin(pathfinder);

// On spawn, initialize pathfinder
bot.once('spawn', () => {
    const movements = new Movements(bot);
    movements.canPlace = false;
    movements.canDig = true;
    
    bot.pathfinder.setMovements(movements);
    console.log('Bot spawned and ready!');
});

// Handle chat commands
bot.on('chat', async (username, message) => {
    if (message === 'mine') {
        bot.chat('Starting to mine oak logs');
        startMining();
    }
    if (message === 'stop') {
        bot.chat('Stopping mining');
        bot.isMining = false;
    }
});

async function startMining() {
    bot.isMining = true;

    while (bot.isMining) {
        try {
            // Find nearest oak log
            const block = bot.findBlock({
                matching: block => block.name === 'oak_log',
                maxDistance: 32
            });

            if (!block) {
                bot.chat('No oak logs found nearby');
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            // Move to the block
            const goal = new GoalNear(block.position.x, block.position.y, block.position.z, 2);
            await bot.pathfinder.goto(goal);

            // Look at the block
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

            // Mine the block
            await bot.dig(block, 'ignore', 'raycast');
            // Small delay before next block
            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (err) {
            console.log('Error while mining:', err);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Error handling
bot.on('error', console.log);
bot.on('kicked', console.log);