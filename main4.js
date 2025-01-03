const { createBot } = require("mineflayer");
const { Manager } = require("/Users/shaurya/Documents/dev/bot/hive/threaded/manager2.js");
const { changetask } = require("./hive/brain/statemachine.js");
const { groupmanager } = require("/Users/shaurya/Documents/dev/bot/hive/threaded/groupmanager2.js");
const { pathfinder } = require("mineflayer-pathfinder");
const { promisify } = require("util");
const { createInterface } = require("readline");
const { Worker } = require('worker_threads');
const path = require('path');
const sleep = promisify(setTimeout);


// task imports
const FindTree = require("./hive/tasks/findtree.js");
const processStump = require("./hive/tasks/choptree.js");
const idle = require("./hive/tasks/idle.js");
const followentity = require("./hive/tasks/followentity.js");
const mineBelow = require("./hive/tasks/minetest.js");
const lumberjack = require("./hive/tasks/lumberjack3.js");

const config = {
    host: "159.54.167.2",
    port: 25567,
    version: "1.21.1",
    numberOfBots: 3,
    botPrefix: 'tree',
    authType: 'offline'
};

// Initialize readline interface
const rl = createInterface({
    input: process.stdin,
    output: process.stdout
});

// Initialize manager with unique name
const botManager = new Manager(config);

// Command definitions
const commands = {
    'chop': async () => {
        await botManager.createTask('lumberjack', {
            type: 'wood_gathering',
            priority: 1,
            data: {
                stumps: []
            }
        });
    },
    'stop': async () => {
        await botManager.stopAllTasks();
    },
    'move': async () => {
        await botManager.createTask('followEntity', {
            type: 'movement',
            priority: 1
        });
    },
    'mine': async () => {
        await botManager.createTask('mining', {
            type: 'resource_gathering',
            priority: 1
        });
    }
};

// Command handler
rl.on('line', async (input) => {
    const [command, ...args] = input.split(' ');
    
    if (commands[command]) {
        try {
            await commands[command](...args);
        } catch (error) {
            console.error(`Error executing command ${command}:`, error);
        }
    } else {
        console.log('Unknown command. Available commands: chop, stop, move, mine');
    }
});

// Status reporting function
async function report() {
    while (true) {
        const activeBots = botManager.getBotCount();
        const activeTasks = botManager.getActiveTaskCount();
        
        console.clear();
        console.log('=== Status Report ===');
        console.log(`Active bots: ${activeBots}`);
        console.log(`Active tasks: ${activeTasks}`);
        console.log('==================');
        
        await sleep(1000);
    }
}

// Main initialization function
async function main() {
    try {
        await botManager.initialize();
        console.log(`Manager initialized with ${config.numberOfBots} bots`);
        
        // Start status reporting
        report().catch(console.error);
        
    } catch (error) {
        console.error('Failed to initialize manager:', error);
        process.exit(1);
    }
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await botManager.shutdown();
    rl.close();
    process.exit(0);
});

// Start the application
main().catch(console.error);