const { goals } = require("mineflayer-pathfinder");
const { Movements } = require('mineflayer-pathfinder');
const { taskmanager } = require("/Users/shaurya/Documents/dev/bot/hive/brain/statemachine.js");

class followentity extends taskmanager {
    static stateName = "followEntity";
    static autonomous = false;

    constructor(bot) {
        super(bot);
        this.movements = undefined;
        this.data = undefined;
        this.followDistance = 0;
    }

    onStateEntered = () => {
        console.log('following colliander');
        const mcData = this.bot.registry;
        this.movements = new Movements(this.bot, mcData);
        this.data = this.bot.nearestEntity(e => e.username === "Collider") ?? undefined;
        this.startMoving(this.data);
    }

    onStateExited() {
        this.stopMoving();
        this.data = undefined;
    }

    exitCase() {
        const distances = this.distanceToTarget();
        return distances < 3;
    }

    setFollowTarget(entity) {
        if (this.data === entity) {
            return;
        }

        this.data = entity;
        this.restart();
    }

    stopMoving() {
        this.bot.pathfinder.setGoal(null);
    }

    startMoving(entity) {
        if (entity == null) return;
        if (entity === this.data && this.bot.pathfinder.isMoving()) return;
        
        const pathfinder = this.bot.pathfinder;
        const goal = new goals.GoalFollow(entity, this.followDistance);
        if (this.movements) pathfinder.setMovements(this.movements);
        pathfinder.setGoal(goal, true);
    }

    restart() {
        if (!this.active) {
            return;
        }

        this.stopMoving();
        this.startMoving(this.data);
    }

    distanceToTarget() {
        if (!this.data) return 0;
        return this.bot.entity.position.distanceTo(this.data.position);
    }
}

module.exports = followentity;
