const mineflayer = require('mineflayer')
const { taskmanager } = require('../brain/statemachine.js');
const Vec3 = require('vec3');
const getNearest = require('../utils/getNearest.js');
const getBestTool = require('../utils/getBestTool.js');
const { goals } = require("mineflayer-pathfinder");
const { Movements } = require('mineflayer-pathfinder');
const { autonomous } = require('./findtree.js');



class processStump extends taskmanager {
    constructor(bot, data) {
        super(bot, data);
        this.movements = undefined;
        this.isMoving = false;
        this.lastMoveTime = Date.now();
        this,autonomous=true
    }
    
    

    onStateEntered() {
        const targetStump = getNearest(this.bot, this.data.stumps);
        if (targetStump) {
            const index = this.data.stumps.indexOf(targetStump);
            this.data.stumps.splice(index, 1);
            
            this.bot.chat(`Processing stump at ${targetStump.x}, ${targetStump.y}, ${targetStump.z}`);
            
            this.state = { 
                targetStump, 
                woodBlocks: [], 
                currentIndex: 0 
            };
            
            const visited = new Set();
            const stumpVec3 = new Vec3(targetStump.x, targetStump.y, targetStump.z);
            const woodSet = this.findConnectedWood(stumpVec3, visited);
            this.state.woodBlocks = Array.from(woodSet).map(posKey => {
                const [x, y, z] = posKey.split(',').map(Number);
                return new Vec3(x, y, z);
            });
            
            return this.state;
        }
        return null;
    }


                
                
    

    findConnectedWood(startPos, visited) {
        const posKey = `${startPos.x},${startPos.y},${startPos.z}`;
        if (!startPos || visited.has(posKey)) {
            return visited;
        }
    
        const block = this.bot.blockAt(startPos);
        if (block && block.name.includes('log')) {
            visited.add(posKey);
            
            // Check adjacent blocks
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    for (let z = -1; z <= 1; z++) {
                        if (x === 0 && y === 0 && z === 0) continue;
                        
                        const newPos = startPos.plus(new Vec3(x, y, z));
                        // Only recurse if position hasn't been visited
                        const newPosKey = `${newPos.x},${newPos.y},${newPos.z}`;
                        if (!visited.has(newPosKey)) {
                            this.findConnectedWood(newPos, visited);
                        }
                    }
                }
            }
        }
        return visited;
    }
    
    
    startMoving(position) {
        if (!position || this.isMoving) return;
        
        const mcData = this.bot.registry;
        this.movements = new Movements(this.bot, mcData);
        const pathfinder = this.bot.pathfinder;
        const goal = new goals.GoalNear(position.x, position.y, position.z, 1.5);
        pathfinder.setMovements(this.movements);
        pathfinder.setGoal(goal, true);
        this.isMoving = true;
    }
    stopMoving() {
        this.bot.pathfinder.setGoal(null);
        this.isMoving = false;
    }

        /*
    async update() {
        if (!this.state || !this.state.woodBlocks || this.state.woodBlocks.length === 0) {
            console.log("No wood blocks in state");
            return this.state;
        }   
        
        const currentBlock = this.state.woodBlocks[this.state.currentIndex];
        if (!currentBlock) {
            console.log("No current block position found");
            return this.state;
        }
        
        if (!this.bot.targetDigBlock) {
            this.startMoving(currentBlock);
            const block = this.bot.blockAt(currentBlock);
            if (block && block.name.includes('log')) {
                try {
                    console.log(`Moving to and mining block at ${currentBlock.x}, ${currentBlock.y}, ${currentBlock.z}`);
                    await this.bot.dig(block, true);
                    this.state.currentIndex++;
                } catch (err) {
                    console.log(`Mining failed: ${err.message}`);
                    this.state.currentIndex++;
                }
            } else {
                this.state.currentIndex++;
            }
        }
        return this.state;
    }

    */
    async update() {
        console.log("ProcessStump State:", {
            hasState: !!this.state,
            blocksLength: this.state?.woodBlocks?.length,
            currentIndex: this.state?.currentIndex
        });
    
        // Check for completion
        if (this.state?.currentIndex >= this.state?.woodBlocks?.length) {
            console.log("Processing complete - emitting completion event");
            this.bot.emit('processStump.complete', {
                success: true,
                state: this.state
            });
            return null;
        }
    
        if (!this.state?.woodBlocks?.length) {
            console.log("No blocks to process");
            this.bot.emit('processStump.complete', {
                success: true,
                state: this.state
            });
            return null;
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
                    this.state.currentIndex++;
                } catch (err) {
                    console.log(`Mining failed: ${err.message}`);
                    this.state.currentIndex++;
                }
            } else {
                this.state.currentIndex++;
            }
        }
    
        return this.state;
    }
    
    
    
    
    

    async moveToBlock(position) {
        return new Promise((resolve) => {
            if (!position) return resolve();
            
            const mcData = this.bot.registry;
            this.movements = new Movements(this.bot, mcData);
            const pathfinder = this.bot.pathfinder;
            const goal = new goals.GoalNear(position.x, position.y, position.z, 1);
            
            pathfinder.setMovements(this.movements);
            pathfinder.setGoal(goal);

            this.bot.once('goal_reached', () => {
                resolve();
            });
        });
    }
    
    
    
    exitCase(state) {
        if (!state?.woodBlocks) return true;
        const isDone = state.currentIndex >= state.woodBlocks.length;
        console.log("Exit case check:", {
            currentIndex: state.currentIndex,
            totalBlocks: state.woodBlocks.length,
            isDone: isDone
        });
        return isDone;
    }
    
    
    
    
    
    
    onStateExited() {
        this.stopMoving();
        this.isMoving = false;
        this.state = null;
        this.bot.removeAllListeners('processStump.complete');
    }
    
    
    
    
}

module.exports = processStump;