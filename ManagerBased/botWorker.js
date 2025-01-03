const { parentPort, workerData } = require('worker_threads');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');
const utils = require('./utils');

class BotWorker {
    constructor(config) {
        this.config = config;
        this.bot = null;
        this.isMining = false;
    }

    async start() {
        this.bot = mineflayer.createBot({
            host: this.config.serverHost,
            port: this.config.serverPort,
            username: this.config.username,
            password: this.config.password,
            auth: 'microsoft',
            version: '1.21.1'
        });

        this.bot.loadPlugin(pathfinder);

        this.bot.once('spawn', () => {
            const defaultMove = new Movements(this.bot);
            defaultMove.canDig = true;
            defaultMove.allowParkour = false;
            defaultMove.allowSprinting = true;
            this.bot.pathfinder.setMovements(defaultMove);
            utils.debugLog(this.bot.username, 'Bot spawned and ready');
        });

        this.bot.on('physicsTick', () => {
            if (this.bot.entity) {
                parentPort.postMessage({
                    type: 'visualization',
                    data: utils.getVisualizationData(this.bot)
                });
            }
        });

        this.setupMessageHandler();
    }

    setupMessageHandler() {
        parentPort.on('message', (message) => {
            if (message.type === 'command') {
                this.handleCommand(message.command);
            }
        });
    }

    async handleCommand(command) {
        switch (command) {
            case 'mine trees':
                await this.startMining('trees');
                break;
            case 'mine ores':
                await this.startMining('ores');
                break;
            case 'stop mining':
                this.stopMining();
                break;
            case 'scan':
                await this.scanSurroundings();
                break;
        }
    }

    async scanSurroundings() {
        utils.debugLog(this.bot.username, "Scanning surroundings...");
        const logs = [];
        const searchRadius = 8;

        for (let x = -searchRadius; x <= searchRadius; x++) {
            for (let y = -searchRadius; y <= searchRadius; y++) {
                for (let z = -searchRadius; z <= searchRadius; z++) {
                    const pos = this.bot.entity.position.offset(x, y, z);
                    const block = this.bot.blockAt(pos);
                    if (block && utils.isLog(block)) {
                        logs.push(`${block.name} at ${block.position}`);
                    }
                }
            }
        }

        utils.debugLog(this.bot.username, `Found ${logs.length} logs:`);
        logs.forEach(log => utils.debugLog(this.bot.username, log));
    }

    async startMining(type) {
        this.isMining = true;
        utils.debugLog(this.bot.username, `Starting to mine ${type}`);
        
        while (this.isMining) {
            try {
                const target = await this.findTarget(type);
                if (target) {
                    await this.mineTarget(target, type === 'trees');
                } else {
                    utils.debugLog(this.bot.username, `No ${type} found, waiting...`);
                    await utils.sleep(1000);
                }
            } catch (error) {
                utils.debugLog(this.bot.username, `Mining error: ${error.message}`);
                await utils.sleep(1000);
            }
        }
    }

    async findTarget(type) {
        const searchRadius = utils.RANGE;
        const botPos = this.bot.entity.position;
        
        let closest = null;
        let closestDistance = Number.MAX_VALUE;

        for (let x = -searchRadius; x <= searchRadius; x++) {
            for (let y = -searchRadius; y <= searchRadius; y++) {
                for (let z = -searchRadius; z <= searchRadius; z++) {
                    const pos = botPos.offset(x, y, z);
                    const block = this.bot.blockAt(pos);
                    
                    if (block && (
                        (type === 'trees' && utils.isLog(block)) ||
                        (type === 'ores' && utils.isOre(block))
                    )) {
                        const distance = botPos.distanceTo(pos);
                        if (distance < closestDistance) {
                            closestDistance = distance;
                            closest = block;
                        }
                    }
                }
            }
        }

        if (closest) {
            return {
                basePosition: closest.position,
                blocks: [closest.position]
            };
        }

        return null;
    }

    async mineTarget(target, isTree) {
        if (!target || !target.blocks || target.blocks.length === 0) return;

        try {
            await this.moveToTarget(target.basePosition);

            const block = this.bot.blockAt(target.basePosition);
            if (!block) return;

            if (isTree) {
                let currentPos = target.basePosition;
                while (true) {
                    const blockAtPos = this.bot.blockAt(currentPos);
                    if (!blockAtPos || !utils.isLog(blockAtPos)) break;

                    await this.mineBlock(blockAtPos);
                    currentPos = currentPos.offset(0, 1, 0);
                }
            } else {
                await this.mineBlock(block);
            }
        } catch (error) {
            utils.debugLog(this.bot.username, `Error mining: ${error.message}`);
        }
    }

    async moveToTarget(position) {
        try {
            const goal = new GoalNear(position.x, position.y, position.z, 2);
            await this.bot.pathfinder.goto(goal);
        } catch (error) {
            utils.debugLog(this.bot.username, `Pathfinding error: ${error.message}`);
            throw error;
        }
    }

    async mineBlock(block) {
        try {
            const distance = this.bot.entity.position.distanceTo(block.position);
            if (distance > 4) {
                await this.moveToTarget(block.position);
            }

            const tool = this.bot.pathfinder.bestHarvestTool(block);
            if (tool) {
                await this.bot.equip(tool, 'hand');
                await utils.sleep(100);
            }

            const blockCenter = block.position.offset(0.5, 0.5, 0.5);
            await this.bot.lookAt(blockCenter);
            await utils.sleep(100);

            if (!this.bot.canDigBlock(block)) {
                utils.debugLog(this.bot.username, `Cannot dig block at ${block.position}`);
                return false;
            }

            await this.bot.dig(block);
            await utils.sleep(250);

            return true;
        } catch (error) {
            utils.debugLog(this.bot.username, `Mining error: ${error.message}`);
            return false;
        }
    }

    stopMining() {
        this.isMining = false;
        this.bot.pathfinder.setGoal(null);
        utils.debugLog(this.bot.username, 'Stopping mining operation');
    }
}

const worker = new BotWorker(workerData);
worker.start().catch(console.error);