const { createBot } = require("mineflayer");
const { CentralHiveMind: manager } = require("/Users/shaurya/Documents/dev/bot/hive/brain/manager.js");
const { changetask } = require("/Users/shaurya/Documents/dev/bot/hive/brain/statemachine.js");
const { groupmanager } = require("/Users/shaurya/Documents/dev/bot/hive/brain/groupmanager.js");
const { pathfinder } = require("mineflayer-pathfinder");
const { promisify } = require("util");
const followentity = require("/Users/shaurya/Documents/dev/bot/hive/tasks/followentity.js");
const idle = require("/Users/shaurya/Documents/dev/bot/hive/tasks/idle.js");
const lookatentity = require("/Users/shaurya/Documents/dev/bot/hive/tasks/lookatentity.js");
const { createInterface } = require("readline");

const sleep = promisify(setTimeout);

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
});

const debug = true;

let hiveMind;
const bots = [];
const updates = [
    new changetask({
        parent: idle,
        child: followentity,
        name: "idleToFollow",
    }),
    new changetask({
        parent: followentity,
        child: idle,
        name: "followToIdle",
    }),
    new changetask({
        parent: idle,
        child: lookatentity,
        name: "idleToLook",
    }),
    new changetask({
        parent: lookatentity,
        child: idle,
        name: "lookToIdle",
    
    }),
];

const test = new groupmanager({
    stateName: "root",
    bots: bots,
    autonomous: false,
    ignoreBusy: false,
    enter: idle,
    updates: updates,
});

async function main() {
    for (let i = 0; i < 2; i++) {
        bots.push(
            createBot({
                username: `test${i}`,
                host: "159.54.167.2",
                version: "1.21.1",
                port: 25567,
            })
        );
        bots[i].loadPlugin(pathfinder);
        await sleep(1000);
    }
    hiveMind = new manager(bots, test);
}

rl.on("line", (input) => {
    const split = input.split(" ");
    switch (split[0]) {
        case "come":
            hiveMind.root.updates[0].trigger();
            break;
        case "movestop":
            hiveMind.root.updates[1].trigger();
            break;
        case "look":
            hiveMind.root.updates[2].trigger();
            break;
        case "lookstop":
            hiveMind.root.updates[3].trigger();
            break;
    }
});

async function report() {
    while (debug) {
        if (hiveMind) {
            console.log(hiveMind.root.activeStateType);
            for (const key of Object.keys(hiveMind.root.runningStates)) {
                //console.log(key, hiveMind.root.runningStates[key].length);
            }
            //console.log(hiveMind.activeBots.length);
        }
        await sleep(1000);
    }
}

main();
report();
