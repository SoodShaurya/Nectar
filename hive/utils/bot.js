const mineflayer = require('mineflayer');
const { parentPort, workerData } = require('worker_threads');
const { StateMachine } = require('./hive/threaded/statemachine2.js');
const Vec3 = require('vec3');

// Bot state and configuration
let currentTask = null;
let isWorking = false;

// Create the bot instance
const bot = mineflayer.createBot({
    host: workerData.host || 'localhost',
    port: workerData.port || 25565,
    username: `bot_${workerData.botId}`,
    auth: workerData.auth || 'offline'
});

// Initialize state machine
let stateMachine = null;

// Message handling from main thread
parentPort.on('message', (message) => {
    console.log('Bot received message:', message);
    switch (message.type) {
        case 'assignTask':
            console.log('Starting task:', message.task);
            handleNewTask(message.task);
            break;
    }
});


// Bot initialization
bot.once('spawn', () => {
    stateMachine = new StateMachine(bot);
    
    // Notify main thread that bot is ready
    parentPort.postMessage({
        type: 'botReady',
        botId: workerData.botId,
        position: bot.entity.position
    });

    // Initialize bot behaviors
    initializeBehaviors();
});

function initializeBehaviors() {
    // Handle pathfinding
    bot.on('path_update', (results) => {
        parentPort.postMessage({
            type: 'pathUpdate',
            botId: workerData.botId,
            status: results.status,
            position: bot.entity.position
        });
    });

    // Handle inventory updates
    bot.on('playerCollect', (collector, collected) => {
        if (collector.username === bot.username) {
            parentPort.postMessage({
                type: 'inventoryUpdate',
                botId: workerData.botId,
                inventory: bot.inventory.items()
            });
        }
    });

    // Handle health updates
    bot.on('health', () => {
        parentPort.postMessage({
            type: 'healthUpdate',
            botId: workerData.botId,
            health: bot.health,
            food: bot.food
        });
    });
}

function handleNewTask(task) {
    if (isWorking) {
        stopCurrentTask();
    }

    currentTask = task;
    isWorking = true;

    switch (task.type) {
        case 'chopTree':
            startTreeChopping(task.target);
            break;
        case 'collectItems':
            startItemCollection(task.items);
            break;
        case 'moveToPosition':
            moveToPosition(task.position);
            break;
    }
}

async function startTreeChopping(target) {
    try {
        const targetBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
        if (!targetBlock || !targetBlock.name.includes('log')) {
            throw new Error('No valid tree found at target location');
        }

        // Navigate to tree
        await bot.pathfinder.goto(targetBlock.position);

        // Start chopping
        await bot.dig(targetBlock);

        parentPort.postMessage({
            type: 'taskComplete',
            botId: workerData.botId,
            task: 'chopTree',
            position: bot.entity.position
        });

    } catch (error) {
        handleError(error, 'chopTree');
    }
}

async function startItemCollection(items) {
    try {
        const entity = bot.nearestEntity(entity => {
            return entity.name === 'item' && 
                   items.includes(entity.getDroppedItem().name);
        });

        if (entity) {
            await bot.pathfinder.goto(entity.position);
            
            parentPort.postMessage({
                type: 'itemCollected',
                botId: workerData.botId,
                item: entity.getDroppedItem().name
            });
        }
    } catch (error) {
        handleError(error, 'collectItems');
    }
}

async function moveToPosition(position) {
    try {
        const goal = new Vec3(position.x, position.y, position.z);
        await bot.pathfinder.goto(goal);
        
        parentPort.postMessage({
            type: 'positionReached',
            botId: workerData.botId,
            position: bot.entity.position
        });
    } catch (error) {
        handleError(error, 'moveToPosition');
    }
}

function stopCurrentTask() {
    if (currentTask) {
        bot.stopDigging();
        bot.pathfinder.stop();
        isWorking = false;
        currentTask = null;

        parentPort.postMessage({
            type: 'taskStopped',
            botId: workerData.botId
        });
    }
}

function updateBotState(newState) {
    if (stateMachine) {
        stateMachine.updateState(newState);
    }
}

function handleError(error, taskType) {
    parentPort.postMessage({
        type: 'error',
        botId: workerData.botId,
        taskType: taskType,
        error: error.message
    });
    stopCurrentTask();
}

// Error handling
bot.on('error', (error) => {
    handleError(error, 'connection');
});

bot.on('end', () => {
    parentPort.postMessage({
        type: 'disconnected',
        botId: workerData.botId
    });
});

process.on('unhandledRejection', (error) => {
    handleError(error, 'unhandled');
});
