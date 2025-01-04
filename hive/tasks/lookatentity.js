const { taskmanager } = require("../brain/statemachine.js");

/**
 * The bot will look at the target entity.
 */
class lookatentity extends taskmanager {
    static stateName = "lookAtEntity";

    constructor(bot) {
        super(bot);
        this.active = false;
        this.data = this.bot.nearestEntity(e => e.type === "player") ?? undefined;
    }

    update() {
        const entity = this.data;
        if (entity != null) {
            this.bot.lookAt(entity.position.offset(0, entity.height, 0)).catch(err => {
                console.log(err);
            });
        }
    }

    /**
     * Gets the distance to the target entity.
     *
     * @returns {number} The distance, or 0 if no target entity is assigned.
     */
    distanceToTarget() {
        const entity = this.data;
        if (entity == null) return 0;

        return this.bot.entity.position.distanceTo(entity.position);
    }
}

module.exports = lookatentity;
