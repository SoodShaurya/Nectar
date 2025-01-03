const minecraftData = require('minecraft-data');
const mcData = minecraftData('1.21.1');
const { taskmanager } = require('/Users/shaurya/Documents/dev/bot/hive/src/statemachine.js');
const Vec3 = require('vec3');
const { goals } = require("mineflayer-pathfinder");
const { Movements } = require('mineflayer-pathfinder');

class lumberjack extends taskmanager {
    static stateName = "lumberjack";

    constructor(bot, data) {
        super(bot, data);
        this.data = data || {};
        if (!this.data.stumps) {
            this.data.stumps = [];
        }
        this.movements = undefined;
        this.isMoving = false;
        this.state = {
            phase: 'finding',
            woodBlocks: [],
            currentIndex: 0
        };
    }

    onStateEntered() {
        console.log('Starting tree harvest cycle');
        this.bot.chat('Starting tree harvest cycle');
        this.findStumps();
    }

    findStumps() {
        const oakLogId = mcData.blocksByName.oak_log.id;
        const dirtId = mcData.blocksByName.dirt.id;
        
        const logs = this.bot.findBlocks({
            matching: oakLogId,
            maxDistance: 32,
            count: 512
        });

        const stumps = logs.filter(pos => {
            const block = this.bot.blockAt(pos);
            if (!block) return false;
            const blockBelow = this.bot.blockAt(pos.offset(0, -1, 0));
            return blockBelow && blockBelow.type === dirtId;
        });

        stumps.forEach(pos => {
            this.data.stumps.push({
                x: pos.x,
                y: pos.y,
                z: pos.z,
                found: Date.now(),
                foundBy: this.bot.username
            });
        });

        this.state.phase = 'processing';
        return this.processNextStump();
    }

    findConnectedWood(startPos, visited = new Set()) {
        const posKey = `${startPos.x},${startPos.y},${startPos.z}`;
        if (!startPos || visited.has(posKey)) return visited;

        const block = this.bot.blockAt(startPos);
        if (block && block.name.includes('log')) {
            visited.add(posKey);
            
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    for (let z = -1; z <= 1; z++) {
                        if (x === 0 && y === 0 && z === 0) continue;
                        const newPos = startPos.plus(new Vec3(x, y, z));
                        this.findConnectedWood(newPos, visited);
                    }
                }
            }
        }
        return visited;
    }

    processNextStump() {
        if (!this.data.stumps.length) {
            this.state.phase = 'finding';
            return null;
        }

        const targetStump = this.data.stumps.shift();
        const stumpVec3 = new Vec3(targetStump.x, targetStump.y, targetStump.z);
        const woodSet = this.findConnectedWood(stumpVec3);
        
        this.state.woodBlocks = Array.from(woodSet).map(posKey => {
            const [x, y, z] = posKey.split(',').map(Number);
            return new Vec3(x, y, z);
        });
        this.state.currentIndex = 0;
        return this.state;
    }

    startMoving(position) {
        if (!position || this.isMoving) return;
        const mcData = this.bot.registry;
        this.movements = new Movements(this.bot, mcData);
        const goal = new goals.GoalNear(position.x, position.y, position.z, 1);
        this.bot.pathfinder.setMovements(this.movements);
        this.bot.pathfinder.setGoal(goal, true);
        this.isMoving = true;
    }

    stopMoving() {
        this.bot.pathfinder.setGoal(null);
        this.isMoving = false;
    }

    async update() {
        if (this.state.phase === 'finding') {
            this.findStumps();
            return this.state;
        }

        if (!this.state.woodBlocks.length || this.state.currentIndex >= this.state.woodBlocks.length) {
            return this.processNextStump();
        }

        const currentBlock = this.state.woodBlocks[this.state.currentIndex];
        if (!currentBlock) {
            this.state.currentIndex++;
            return this.state;
        }

        if (!this.bot.targetDigBlock && !this.isMoving) {
            this.startMoving(currentBlock);
        }

        if (this.isMoving && this.bot.entity.position.distanceTo(currentBlock) <= 1.5) {
            this.stopMoving();
            const block = this.bot.blockAt(currentBlock);
            if (block && block.name.includes('log')) {
                try {
                    await this.bot.dig(block, true);
                } catch (err) {
                    console.log(`Mining failed: ${err.message}`);
                }
            }
            this.state.currentIndex++;
        }

        return this.state;
    }

    exitCase() {
        return !this.data.stumps.length && 
               this.state.phase === 'processing' && 
               (!this.state.woodBlocks.length || 
                this.state.currentIndex >= this.state.woodBlocks.length);
    }

    onStateExited() {
        this.stopMoving();
        this.isMoving = false;
        this.state = null;
        console.log('Exiting tree harvest state');
        this.bot.chat('Exiting tree harvest state');
    }
}

module.exports = lumberjack;
