const { Bot, Player } = require("mineflayer");
const { Entity } = require("prismarine-entity");
const { Item } = require("prismarine-item");
const Vec3 = require("vec3");

class taskmanager {
    static stateName = this.constructor.name;
    static autonomous = false;

    constructor(bot, data) {
        this.bot = bot;
        this.data = data;
        this.active = false;
    }

    onStateEntered() {}

    update() {}

    onStateExited() {}

    exitCase() {
        return false;
    }
}
class changetask {
    constructor({ 
        parent, 
        child, 
        name, 
        shouldChange = () => false, 
        onTransition = () => {} 
    }) {
        this.parentState = parent;
        this.childState = child;
        this.triggerState = false;
        this.shouldChange = shouldChange;
        this.onTransition = onTransition;
        this.name = name;
    }

    trigger() {
        this.triggerState = true;
    }

    isTriggered() {
        return this.triggerState;
    }

    resetTrigger() {
        this.triggerState = false;
    }
}

/**
 * @typedef {Object} StateMachineTargets
 * @property {import('prismarine-entity').Entity} [entity]
 * @property {import('vec3').Vec3} [position]
 * @property {import('prismarine-item').Item} [item]
 * @property {import('mineflayer').Player} [player]
 * @property {import('vec3').Vec3} [blockFace]
 * @property {import('prismarine-entity').Entity[]} [entities]
 * @property {import('vec3').Vec3[]} [positions]
 * @property {import('prismarine-item').Item[]} [items]
 * @property {import('mineflayer').Player[]} [players]
 */

module.exports = {
    taskmanager,
    changetask
};
