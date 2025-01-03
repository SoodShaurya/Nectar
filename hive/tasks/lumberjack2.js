const minecraftData = require('minecraft-data');
const mcData = minecraftData('1.21.1');
const { taskmanager } = require('../brain/statemachine.js');
const Vec3 = require('vec3');
const { goals } = require("mineflayer-pathfinder");
const { Movements } = require('mineflayer-pathfinder');

class lumberjack extends taskmanager {
    static stateName = "lumberjack";
    static autonomous = true;

    constructor(bot, data) {
        super(bot, data);
        this.data = data || {};
        if (!this.data.stumps) {
            this.data.stumps = [];
        }
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

        console.log(`Found ${stumps.length} stumps`);
        this.bot.chat(`Found ${stumps.length} stumps`);
        this.state.phase = 'processing';
        return this.processNextStump();
    }

    findConnectedWood(startPos, visited = new Set()) {
        const posKey = `${startPos.x},${startPos.y},${startPos.z}`;
        if (!startPos || visited.has(posKey)) return visited;

        const block = this.bot.blockAt(startPos);
        if (block && block.name.includes('log')) {
            visited.add(posKey);
            
            // Check all adjacent blocks including diagonals
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
        // If we still have blocks to mine in the current tree, don't switch trees
        if (this.state.woodBlocks.length > 0 && this.state.currentIndex < this.state.woodBlocks.length) {
            return this.state;
        }

        if (!this.data.stumps.length) {
            this.state.phase = 'finding';
            return null;
        }

        const targetStump = this.data.stumps[0]; // Don't remove yet
        const stumpVec3 = new Vec3(targetStump.x, targetStump.y, targetStump.z);
        const woodSet = this.findConnectedWood(stumpVec3);
        
        this.state.woodBlocks = Array.from(woodSet).map(posKey => {
            const [x, y, z] = posKey.split(',').map(Number);
            return new Vec3(x, y, z);
        });

        // Sort blocks from bottom to top
        this.state.woodBlocks.sort((a, b) => a.y - b.y);
        
        if (this.state.woodBlocks.length > 0) {
            this.currentTree = targetStump;
            this.data.stumps.shift();
            this.state.currentIndex = 0;
            console.log(`Processing tree with ${this.state.woodBlocks.length} blocks at ${stumpVec3}`);
        }

        return this.state;
    }

    async mineBlock(block) {
        if (this.isDigging) {
            return false;
        }
        
        try {
            this.isDigging = true;
            await this.lookAtBlock(block.position);
            
            while (true) {
                await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                const targetBlock = this.bot.blockAtCursor(4); // Specify max distance of 4 blocks
                
                if (!targetBlock) {
                    console.log("No target block found - block may be out of sight");
                    return false;
                }
                
                console.log(`Current target block: ${targetBlock.name} at position ${targetBlock.position}`);
                
                if (targetBlock.position.equals(block.position)) {
                    await this.bot.dig(targetBlock, true);
                    this.lastDigTime = Date.now();
                    this.digAttempts = 0;
                    return true;
                }
                
                console.log(`Mining obstructing block: ${targetBlock.name}`);
                await this.bot.dig(targetBlock, true);
            }
        } catch (err) {
            console.log(`Mining failed: ${err.message}`);
            return false;
        } finally {
            this.isDigging = false;
        }
    }
    
    
    
    
    

    async update() {
        if (this.state.phase === 'finding') {
            this.findStumps();
            return this.state;
        }

        if (this.checkStuck()) {
            return this.state;
        }

        if (this.isMoving && Date.now() - this.lastMoveTime > 5000) {
            console.log("Movement timeout, resetting...");
            this.stopMoving();
            return this.state;
        }

        // Verify current tree still exists
        if (this.currentTree && this.state.woodBlocks.length > 0) {
            // Check if any wood blocks remain from the current tree
            const remainingBlocks = this.state.woodBlocks.filter(pos => {
                const block = this.bot.blockAt(pos);
                return block && block.name.includes('log');
            });
            
            if (remainingBlocks.length === 0) {
                console.log("Tree completely harvested, moving to next");
                this.state.woodBlocks = [];
                this.state.currentIndex = 0;
                this.currentTree = null;
                return this.processNextStump();
            }
            
            // Update woodBlocks to only include remaining blocks
            this.state.woodBlocks = remainingBlocks;
            this.state.currentIndex = 0;
        }

        if (!this.state.woodBlocks.length || this.state.currentIndex >= this.state.woodBlocks.length) {
            return this.processNextStump();
        }

        const currentBlock = this.state.woodBlocks[this.state.currentIndex];
        if (!currentBlock) {
            this.state.currentIndex++;
            return this.state;
        }

        // Don't start new actions if currently digging
        if (this.isDigging) {
            return this.state;
        }

        const distanceToBlock = this.bot.entity.position.distanceTo(currentBlock);
        if (distanceToBlock > 4) {
            if (!this.isMoving) {
                console.log(`Moving to block at ${currentBlock.x}, ${currentBlock.y}, ${currentBlock.z}`);
                this.startMoving(currentBlock);
            }
            return this.state;
        }

        if (this.isMoving) {
            this.stopMoving();
        }

        const block = this.bot.blockAt(currentBlock);
        if (!block || !block.name.includes('log')) {
            this.state.currentIndex++;
            return this.state;
        }

        const success = await this.mineBlock(block);
        if (!success && this.digAttempts < this.maxDigAttempts) {
            await this.retryDig(block);
        } else if (success) {
            this.state.currentIndex++;
        }

        return this.state;
    }

    exitCase() {
        return !this.data.stumps.length && 
               this.state.phase === 'processing' && 
               (!this.state.woodBlocks.length || 
                this.state.currentIndex >= this.state.woodBlocks.length) &&
               !this.isMoving && 
               this.digAttempts === 0 &&
               !this.currentTree;
    }
    async retryDig(block) {
        if (this.isDigging) {
            return false;
        }

        this.digAttempts++;
        if (this.digAttempts > this.maxDigAttempts) {
            console.log(`Failed to mine block after ${this.maxDigAttempts} attempts, skipping...`);
            this.digAttempts = 0;
            this.state.currentIndex++;
            return false;
        }

        try {
            this.isDigging = true;
            await this.lookAtBlock(block.position);
            await this.bot.dig(block, true);
            this.digAttempts = 0;
            return true;
        } catch (err) {
            console.log(`Dig attempt ${this.digAttempts} failed: ${err.message}`);
            return false;
        } finally {
            this.isDigging = false;
        }
    }

    checkStuck() {
        if (!this.state.lastPosition) {
            this.state.lastPosition = this.bot.entity.position.clone();
            return false;
        }

        const currentPos = this.bot.entity.position;
        const distance = currentPos.distanceTo(this.state.lastPosition);
        
        if (distance < 0.1 && this.isMoving) {
            this.state.stuckTime += 1;
            if (this.state.stuckTime > 10) { // Stuck for 10 ticks
                console.log("Bot appears to be stuck, resetting movement...");
                this.stopMoving();
                this.state.stuckTime = 0;
                return true;
            }
        } else {
            this.state.stuckTime = 0;
        }

        this.state.lastPosition = currentPos.clone();
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

    async lookAtBlock(pos) {
        try {
            await this.bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
            // Small delay to ensure the bot has properly oriented itself
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
            console.log(`Failed to look at block: ${err.message}`);
        }
    }

    // ... previous helper methods (lookAtBlock, startMoving, stopMoving, etc.) ...
}

module.exports = lumberjack;
