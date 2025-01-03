const { taskmanager } = require('../brain/statemachine.js');

class mineBelow extends taskmanager {
    constructor(bot, data) {
        super(bot, data);
    }

    onStateEntered() {
        let blockPosition = this.bot.entity.position.offset(0, -1, 0);
        let block = this.bot.blockAt(blockPosition);

        this.bot.dig(block, false);
        this.bot.chat("Dug.");
    }
}


module.exports = mineBelow;
