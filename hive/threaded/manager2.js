const { Worker } = require('worker_threads');
const { GroupManager } = require('./hive/threaded/groupmanager2.js');
const path = require('path');

class Manager {
    constructor(config) {
        this.config = {
            host: config.host || 'localhost',
            port: config.port || 25565,
            numberOfBots: config.numberOfBots || 1,
            botPrefix: config.botPrefix || 'worker_bot_',
            authType: config.authType || 'offline',
            ...config
        };

        this.groupManager = new GroupManager();
        this.workers = new Map();
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;

        try {
            await this.spawnBots();
            this.setupGroupManager();
            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to initialize manager:', error);
            throw error;
        }
    }

    async spawnBots() {
        const spawnPromises = [];
        
        for (let i = 0; i < this.config.numberOfBots; i++) {
            spawnPromises.push(this.createBotWorker(i));
        }

        await Promise.all(spawnPromises);
    }

    createBotWorker(index) {
        return new Promise((resolve, reject) => {
            const botId = `${this.config.botPrefix}${index}`;
            
            // Fix the path by using the correct location
            const workerPath = './hive/utils/bot.js';
            
            const worker = new Worker(workerPath, {
                workerData: {
                    botId: botId,
                    host: this.config.host,
                    port: this.config.port,
                    auth: this.config.authType,
                    username: botId,
                    version: this.config.version
                }
            });
    
            worker.on('online', () => {
                this.workers.set(botId, worker);
                this.groupManager.registerBot(botId, worker);
                resolve();
            });
    
            worker.on('error', (error) => {
                console.error(`Worker ${botId} error:`, error);
                reject(error);
            });
        });
    }
    

    setupGroupManager() {
        // Create default work groups
        this.groupManager.createGroup('lumberjacks', 'wood_gathering');
        this.groupManager.createGroup('miners', 'mining');
        this.groupManager.createGroup('builders', 'construction');

        // Handle group manager events
        this.groupManager.on('botReady', (botId) => {
            this.assignBotToDefaultGroup(botId);
        });

        this.groupManager.on('botError', ({ botId, error }) => {
            this.handleBotError(botId, error);
        });
    }

    assignBotToDefaultGroup(botId) {
        const groupAssignments = {
            0: 'lumberjacks',
            1: 'miners',
            2: 'builders'
        };

        const botIndex = parseInt(botId.split('_').pop());
        const groupType = groupAssignments[botIndex % 3];
        this.groupManager.addToGroup(botId, groupType);
    }

    async createTask(taskType, parameters) {
        if (!this.isInitialized) {
            throw new Error('Manager not initialized');
        }

        const taskId = this.groupManager.createTask(taskType, parameters);
        return taskId;
    }

    async stopTask(taskId) {
        const task = this.groupManager.getTaskStatus(taskId);
        if (task) {
            for (const botId of task.assignedBots) {
                const worker = this.workers.get(botId);
                if (worker) {
                    worker.postMessage({ type: 'stop' });
                }
            }
        }
    }

    async stopAllTasks() {
        for (const [botId, worker] of this.workers) {
            worker.postMessage({ type: 'stop' });
        }
    }

    handleWorkerError(botId, error) {
        console.error(`Bot ${botId} encountered an error:`, error);
        this.groupManager.handleBotError(botId, error);
        this.restartWorker(botId);
    }

    handleWorkerExit(botId) {
        this.workers.delete(botId);
        this.groupManager.unregisterBot(botId);
        
        // Attempt to restart the worker
        setTimeout(() => this.restartWorker(botId), 5000);
    }

    async restartWorker(botId) {
        try {
            const index = parseInt(botId.split('_').pop());
            await this.createBotWorker(index);
            console.log(`Successfully restarted worker ${botId}`);
        } catch (error) {
            console.error(`Failed to restart worker ${botId}:`, error);
        }
    }

    handleBotError(botId, error) {
        console.error(`Bot ${botId} error:`, error);
        // Implement specific error handling logic
    }

    // API Methods for external control
    async assignBotToGroup(botId, groupId) {
        this.groupManager.addToGroup(botId, groupId);
    }

    async getBotStatus(botId) {
        return this.groupManager.getBotStatus(botId);
    }

    async getGroupStatus(groupId) {
        return {
            members: this.groupManager.getGroupMembers(groupId),
            tasks: Array.from(this.groupManager.tasks.values())
                .filter(task => task.assignedBots.has(groupId))
        };
    }

    async shutdown() {
        await this.stopAllTasks();
        
        const shutdownPromises = Array.from(this.workers.values()).map(worker => {
            return new Promise((resolve) => {
                worker.on('exit', resolve);
                worker.postMessage({ type: 'shutdown' });
            });
        });

        await Promise.all(shutdownPromises);
        this.workers.clear();
        this.isInitialized = false;
    }

    // Utility methods
    getConnectedBots() {
        return Array.from(this.workers.keys());
    }

    getActiveTaskCount() {
        return this.groupManager.tasks.size;
    }

    getBotCount() {
        return this.workers.size;
    }
}

module.exports = { Manager };
