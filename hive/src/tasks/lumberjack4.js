const { task } = require('/Users/shaurya/Documents/dev/bot/hive/threaded/statemachine2.js');
const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { Movements } = require('mineflayer-pathfinder');

class Lumberjacktask extends task {
    constructor(bot) {
        super(bot);
        this.data = {
            stumps: []
        };
        this.movements = undefined;
        this.isMoving = false;
        this.lastMoveTime = Date.now();
        this.lastDigTime = Date.now();
        this.digAttempts = 0;
        this.maxDigAttempts = 3;
        this.currentTree = null;
        this.isDigging = false;
        this.state = {
            phase: 'finding',
            woodBlocks: [],
            currentIndex: 0,
            lastPosition: null,
            stuckTime: 0
        };
    }

    async start(data) {
        await super.start(data);
        if (data.stumps) {
            this.data.stumps = data.stumps;
        }
        this.findStumps();
    }

    findStumps() {
        const mcData = this.bot.registry;
        const oakLogId = mcData.blocksByName.oak_log.id;
        const dirtId = mcData.blocksByName.dirt.id;
        
        const logs = this.bot.findBlocks({
            matching: oakLogId,
            maxDistance: 64,
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
        this.processNextStump();
    }

    findConnectedWood(startPos, visited = new Set()) {
        const posKey = `${startPos.x},${startPos.y},${startPos.z}`;
        if (!startPos || visited.has(posKey)) return visited;

        const block = this.bot.blockAt(startPos);
        if (block && block.name.includes('log')) {
            visited.add(posKey);
            
            for (let y = -1; y <= 1; y++) {
                for (let x = -1; x <= 1; x++) {
                    for (let z = -1; z <= 1; z++) {
                        if (x === 0 && y === 0 && z === 0) continue;
                        const newPos = startPos.plus(new Vec3(x, y, z));
                        const newBlock = this.bot.blockAt(newPos);
                        if (newBlock && newBlock.name.includes('log')) {
                            this.findConnectedWood(newPos, visited);
                        }
                    }
                }
            }
        }
        return visited;
    }

    processNextStump() {
        if (this.state.woodBlocks.length > 0 && this.state.currentIndex < this.state.woodBlocks.length) {
            return;
        }

        if (!this.data.stumps.length) {
            this.state.phase = 'finding';
            return;
        }

        const targetStump = this.data.stumps[0];
        const stumpVec3 = new Vec3(targetStump.x, targetStump.y, targetStump.z);
        const woodSet = this.findConnectedWood(stumpVec3);

        this.state.woodBlocks = Array.from(woodSet).map(posKey => {
            const [x, y, z] = posKey.split(',').map(Number);
            return new Vec3(x, y, z);
        }).sort((a, b) => a.y - b.y);

        if (this.state.woodBlocks.length > 0) {
            this.currentTree = targetStump;
            this.data.stumps.shift();
            this.state.currentIndex = 0;
        }
    }

    async update() {
        if (!this.isRunning) return;

        if (this.state.phase === 'finding') {
            this.findStumps();
            return;
        }

        if (this.checkStuck()) return;

        if (this.isMoving && Date.now() - this.lastMoveTime > 5000) {
            this.stopMoving();
            return;
        }

        await this.harvestTree();
    }

    async harvestTree() {
        if (!this.state.woodBlocks.length || this.state.currentIndex >= this.state.woodBlocks.length) {
            this.processNextStump();
            return;
        }

        const currentBlock = this.state.woodBlocks[this.state.currentIndex];
        if (!currentBlock) {
            this.state.currentIndex++;
            return;
        }

        if (this.isDigging) return;

        const distanceToBlock = this.bot.entity.position.distanceTo(currentBlock);
        if (distanceToBlock > 2.5) {
            if (!this.isMoving) {
                this.startMoving(currentBlock);
            }
            return;
        }

        if (this.isMoving) {
            this.stopMoving();
        }

        const block = this.bot.blockAt(currentBlock);
        if (!block || !block.name.includes('log')) {
            this.state.currentIndex++;
            return;
        }

        const success = await this.mineBlock(block);
        if (success) {
            this.state.currentIndex++;
        } else if (this.digAttempts < this.maxDigAttempts) {
            await this.retryDig(block);
        }
    }

    async stop() {
        await super.stop();
        this.stopMoving();
        this.isDigging = false;
    }

    // Helper methods remain mostly unchanged
    checkStuck() {
        if (!this.state.lastPosition) {
            this.state.lastPosition = this.bot.entity.position.clone();
            return false;
        }

        const velocity = this.bot.entity.velocity;
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z);

        if (speed < 0.01 && this.isMoving) {
            this.state.stuckTime += 1;
            if (this.state.stuckTime > 10) {
                this.stopMoving();
                this.state.stuckTime = 0;
                return true;
            }
        } else {
            this.state.stuckTime = 0;
        }

        this.state.lastPosition = this.bot.entity.position.clone();
        return false;
    }

    startMoving(position) {
        if (!position || this.isMoving) return;
        
        const mcData = this.bot.registry;
        this.movements = new Movements(this.bot, mcData);
        this.movements.canDig = true;
        this.movements.allowFreeMotion = true;
        
        const goal = new goals.GoalNear(position.x, position.y, position.z, 3);
        this.bot.pathfinder.setMovements(this.movements);
        this.bot.pathfinder.setGoal(goal, true);
        
        this.isMoving = true;
        this.lastMoveTime = Date.now();
    }

    stopMoving() {
        this.bot.pathfinder.setGoal(null);
        this.isMoving = false;
        this.state.stuckTime = 0;
    }
}

module.exports = Lumberjacktask;
