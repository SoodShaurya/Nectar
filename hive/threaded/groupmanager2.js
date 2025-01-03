const { EventEmitter } = require('events');
const Vec3 = require('vec3');

class GroupManager extends EventEmitter {
    constructor() {
        super();
        this.bots = new Map(); // Map of botId -> botInfo
        this.tasks = new Map(); // Map of taskId -> taskInfo
        this.sharedResources = new Map(); // Map of resourceId -> resourceInfo
        this.workGroups = new Map(); // Map of groupId -> groupInfo
        this.taskQueue = [];
    }

    // Bot Management
    registerBot(botId, worker) {
        this.bots.set(botId, {
            id: botId,
            worker: worker,
            status: 'idle',
            position: null,
            inventory: [],
            currentTask: null,
            health: 20,
            food: 20,
            group: null
        });

        worker.on('message', (message) => this.handleBotMessage(botId, message));
    }

    unregisterBot(botId) {
        const bot = this.bots.get(botId);
        if (bot && bot.group) {
            this.removeFromGroup(botId, bot.group);
        }
        this.bots.delete(botId);
    }

    // Group Management
    createGroup(groupId, groupType) {
        this.workGroups.set(groupId, {
            id: groupId,
            type: groupType,
            members: new Set(),
            assignedArea: null,
            sharedData: new Map()
        });
    }

    addToGroup(botId, groupId) {
        const group = this.workGroups.get(groupId);
        const bot = this.bots.get(botId);
        
        if (group && bot) {
            group.members.add(botId);
            bot.group = groupId;
            this.broadcastGroupUpdate(groupId);
        }
    }

    removeFromGroup(botId, groupId) {
        const group = this.workGroups.get(groupId);
        if (group) {
            group.members.delete(botId);
            const bot = this.bots.get(botId);
            if (bot) bot.group = null;
            this.broadcastGroupUpdate(groupId);
        }
    }

    // Task Management
    createTask(taskType, parameters) {
        const taskId = Date.now().toString();
        const task = {
            id: taskId,
            type: taskType,
            parameters: parameters,
            status: 'pending',
            assignedBots: new Set(),
            progress: 0
        };
        
        this.tasks.set(taskId, task);
        this.taskQueue.push(taskId);
        this.processTaskQueue();
        return taskId;
    }

    assignTask(taskId, botId) {
        const task = this.tasks.get(taskId);
        const bot = this.bots.get(botId);
        
        if (task && bot && bot.status === 'idle') {
            console.log(`Assigning task ${taskId} to bot ${botId}`);
            task.assignedBots.add(botId);
            bot.currentTask = taskId;
            bot.status = 'working';
            
            bot.worker.postMessage({
                type: 'assignTask',
                task: {
                    type: task.type,
                    ...task.parameters
                }
            });
        }
    }
    

    // Resource Management
    registerResource(resourceId, position, type) {
        this.sharedResources.set(resourceId, {
            id: resourceId,
            position: position,
            type: type,
            status: 'available',
            assignedBot: null
        });
    }

    claimResource(resourceId, botId) {
        const resource = this.sharedResources.get(resourceId);
        if (resource && resource.status === 'available') {
            resource.status = 'claimed';
            resource.assignedBot = botId;
            return true;
        }
        return false;
    }

    // Message Handling
    handleBotMessage(botId, message) {
        const bot = this.bots.get(botId);
        if (!bot) return;

        switch (message.type) {
            case 'botReady':
                this.updateBotPosition(botId, message.position);
                this.emit('botReady', botId);
                break;

            case 'pathUpdate':
                this.updateBotPosition(botId, message.position);
                break;

            case 'inventoryUpdate':
                this.updateBotInventory(botId, message.inventory);
                break;

            case 'healthUpdate':
                this.updateBotHealth(botId, message.health, message.food);
                break;

            case 'taskComplete':
                this.handleTaskCompletion(botId, message);
                break;

            case 'error':
                this.handleBotError(botId, message);
                break;
        }

        // Broadcast updates to group if bot is in one
        if (bot.group) {
            this.broadcastGroupUpdate(bot.group);
        }
    }

    // Update Methods
    updateBotPosition(botId, position) {
        const bot = this.bots.get(botId);
        if (bot) {
            bot.position = new Vec3(position.x, position.y, position.z);
        }
    }

    updateBotInventory(botId, inventory) {
        const bot = this.bots.get(botId);
        if (bot) {
            bot.inventory = inventory;
        }
    }

    updateBotHealth(botId, health, food) {
        const bot = this.bots.get(botId);
        if (bot) {
            bot.health = health;
            bot.food = food;
        }
    }

    // Task Processing
    processTaskQueue() {
        while (this.taskQueue.length > 0) {
            const taskId = this.taskQueue[0];
            const task = this.tasks.get(taskId);
            
            const availableBot = this.findAvailableBot(task);
            if (!availableBot) break;

            this.assignTask(taskId, availableBot);
            this.taskQueue.shift();
        }
    }

    findAvailableBot(task) {
        for (const [botId, bot] of this.bots) {
            if (bot.status === 'idle' && this.isBotSuitableForTask(bot, task)) {
                return botId;
            }
        }
        return null;
    }

    isBotSuitableForTask(bot, task) {
        // Add task-specific criteria here
        return true;
    }

    // Group Communication
    broadcastGroupUpdate(groupId) {
        const group = this.workGroups.get(groupId);
        if (!group) return;

        const groupData = {
            members: Array.from(group.members).map(botId => ({
                id: botId,
                position: this.bots.get(botId).position,
                status: this.bots.get(botId).status
            })),
            sharedData: Object.fromEntries(group.sharedData)
        };

        group.members.forEach(botId => {
            const bot = this.bots.get(botId);
            if (bot && bot.worker) {
                bot.worker.postMessage({
                    type: 'groupUpdate',
                    groupData: groupData
                });
            }
        });
    }

    // Error Handling
    handleBotError(botId, errorMessage) {
        const bot = this.bots.get(botId);
        if (bot) {
            bot.status = 'error';
            if (bot.currentTask) {
                const task = this.tasks.get(bot.currentTask);
                if (task) {
                    task.assignedBots.delete(botId);
                    this.taskQueue.unshift(bot.currentTask);
                }
                bot.currentTask = null;
            }
        }
        this.emit('botError', { botId, error: errorMessage });
    }

    handleTaskCompletion(botId, message) {
        const bot = this.bots.get(botId);
        if (!bot) return;

        const task = this.tasks.get(bot.currentTask);
        if (task) {
            task.assignedBots.delete(botId);
            if (task.assignedBots.size === 0) {
                task.status = 'completed';
                this.tasks.delete(bot.currentTask);
            }
        }

        bot.status = 'idle';
        bot.currentTask = null;
        this.processTaskQueue();
    }

    // Utility Methods
    getGroupMembers(groupId) {
        const group = this.workGroups.get(groupId);
        return group ? Array.from(group.members) : [];
    }

    getBotStatus(botId) {
        return this.bots.get(botId);
    }

    getTaskStatus(taskId) {
        return this.tasks.get(taskId);
    }
}

module.exports = { GroupManager };
