const mineflayer = require("mineflayer");
const movement = require("/Users/shaurya/Documents/dev/bot/movement/index.js");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const bot = mineflayer.createBot({
    host: "159.54.167.2", // Server IP
    port: "25567",        // Server Port
    username: "shaurisood@hotmail.com", // Bot's username
    auth: "microsoft",    // Authentication method
    version: "1.21",      // Minecraft version
});
bot.loadPlugin(movement.plugin);
bot.loadPlugin(pathfinder);

bot.once("spawn", () => {
    const mcData = require("minecraft-data")(bot.version);
    const defaultMovements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMovements);

    bot.chat("Bot is ready!");

    bot.on("chat", async (username, message) => {
        if (message === "come") {
            const target = bot.players[username]?.entity;
            if (!target) {
                bot.chat("I can't see you!");
                return;
            }

            const goal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);

            try {
                const path = bot.pathfinder.getPathTo(defaultMovements, goal);

                if (path.status === "success") {
                    bot.chat("Path calculated, moving to target");
                    followPathWithMovement(path.path); // Pass nodes to movement function
                } else {
                    bot.chat("No path found");
                }
            } catch (err) {
                bot.chat("Couldnt reach target");
                console.error(err);
            }
        }
    });
});

// Function to integrate mineflayer-movement for smooth node-to-node navigation
function followPathWithMovement(nodes) {
    const proximityHeuristic = bot.movement.heuristic.register("proximity");
    const dangerHeuristic = bot.movement.heuristic.register("danger");

    dangerHeuristic.weight(1).radius(3).depth(5).avoid({ lava: true }); // Avoid hazards like lava

    let currentNodeIndex = 0;

    bot.on("physicsTick", () => {
        if (currentNodeIndex >= nodes.length) {
            bot.setControlState("forward", false);
            bot.setControlState("sprint", false)
            bot.setControlState("jump", false)
            return;
        }

        const currentNode = nodes[currentNodeIndex];
        proximityHeuristic.target(new Vec3(currentNode.x, currentNode.y, currentNode.z));

        const yaw = bot.movement.getYaw(240, 15, 1); // Get optimal yaw angle
        if (yaw !== null) {
            bot.movement.steer(yaw);
            bot.setControlState("forward", true);
            bot.setControlState("sprint", true)
            bot.setControlState("jump", true)
            

            // Check distance to node and move to next when close enough
            const distance = bot.entity.position.distanceTo(new Vec3(currentNode.x, currentNode.y, currentNode.z));
            if (distance < 1) { // Adjust threshbrain as needed
                currentNodeIndex++;
                if (currentNodeIndex < nodes.length) {
                    bot.chat(`moving to node ${currentNodeIndex + 1}/${nodes.length}`);
                }
            }
        }
    });
}