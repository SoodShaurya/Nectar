const { taskmanager } = require('../brain/statemachine.js');

/**
 * The bot will stand idle and do... nothing.
 */
// In idle.js
class idle extends taskmanager {
    constructor(bot) {
        super(bot);
    }
    onStateEntered = () => {
            
            this.bot.chat('idle...');
        }
}
module.exports = idle;  // Export the class directly, not an object
