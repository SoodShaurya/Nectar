const minecraftData = require('minecraft-data')
const mcData = minecraftData('1.21.1')
const { taskmanager } = require("/Users/shaurya/Documents/dev/bot/hive/brain/statemachine.js");

class FindTreeState extends taskmanager {
    static stateName = "findTree";
    static autonomous = false;

    constructor(bot, data) {
        super(bot);
        // Initialize data if not passed
        this.data = data || {};
        // Ensure stumps array exists
        if (!this.data.stumps) {
            this.data.stumps = [];
        }
    }

    onStateEntered = () => {
        console.log('Bot entering FindTree state - searching for tree stumps...');
        this.bot.chat('Bot entering FindTree state - searching for tree stumps...');
        const foundLogs = this.searchForStumps();
        
        // Simply add all found logs to data.stumps
        if (!this.data.stumps) {
            this.data.stumps = [];
        }

        foundLogs.forEach(pos => {
            this.data.stumps.push({
                x: pos.x,
                y: pos.y,
                z: pos.z,
                found: Date.now(),
                foundBy: this.bot.username
            });
        });

        if (this.data.stumps && this.data.stumps.length > 0) {
            this.data.stumps = Array.from(new Set(this.data.stumps.map(JSON.stringify)))
                .map(JSON.parse)
                .filter((stump, index, self) => 
                    index === self.findIndex(s => 
                        s.x === stump.x && 
                        s.y === stump.y && 
                        s.z === stump.z
                    )
                );
        }
        console.log(`Found ${foundLogs.length} logs`);
        this.bot.chat(`Found ${foundLogs.length} logs`);
        console.log(`Current stumps array size: ${this.data.stumps.length}`);
        this.bot.chat(`Current stumps array size: ${this.data.stumps.length}`);
    }

    searchForStumps() {
        const oakLogId = mcData.blocksByName.oak_log.id;
        const dirtId = mcData.blocksByName.dirt.id;
        
        const logs = this.bot.findBlocks({
            matching: oakLogId,
            maxDistance: 32,
            count: 512
        });

        console.log(`Initial log blocks found: ${logs.length}`);
        this.bot.chat(`Initial log blocks found: ${logs.length}`);

        const stumps = logs.filter(pos => {
            const block = this.bot.blockAt(pos);
            if (!block) return false;
            
            const blockBelow = this.bot.blockAt(pos.offset(0, -1, 0));
            if (!blockBelow) return false;
            
            return blockBelow.type === dirtId;
        });

        console.log(`Stumps: ${stumps.length}`);
        return stumps;
    }

    onStateExited() {
        console.log('Exiting FindTree state');
        this.bot.chat('Exiting FindTree state');
        // Don't clear stumps data on exit to maintain persistence
    }
}

module.exports = FindTreeState;
