const { parentPort, workerData } = require('worker_threads');
const { createBot } = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const lumberjack = require('/Users/shaurya/Documents/dev/bot/hive/tasks/lumberjack4.js');
const idle = require('/Users/shaurya/Documents/dev/bot/hive/tasks/idle.js');

// Create bot instance
const bot = createBot(workerData.options);
bot.loadPlugin(pathfinder);

// Bot state
let currentState = null;

// Handle messages from main thread
parentPort.on('message', async (message) => {
    switch(message.type) {
        case 'setState':
            if (message.state === 'lumberjack') {
                currentState = new lumberjack(bot, message.data);
                await currentState.onStateEntered();
            } else if (message.state === 'idle') {
                currentState = new idle(bot);
                await currentState.onStateEntered();
            }
            break;
            
        case 'update':
            if (currentState) {
                const state = await currentState.update();
                parentPort.postMessage({ 
                    type: 'stateUpdate', 
                    state: state,
                    activeState: currentState.constructor.stateName
                });
            }
            break;
    }
});

// Handle bot events
bot.on('spawn', () => {
    parentPort.postMessage({ type: 'spawn', username: bot.username });
});

bot.on('error', (error) => {
    parentPort.postMessage({ type: 'error', error: error.message });
});
