const { createBot } = require("mineflayer");
const { CentralHiveMind: manager } = require("/Users/shaurya/Documents/dev/bot/hive/src/brain/manager.js");
const { changetask } = require("/Users/shaurya/Documents/dev/bot/hive/src/brain/statemachine.js");
const { groupmanager } = require("/Users/shaurya/Documents/dev/bot/hive/src/brain/groupmanager.js");
const { pathfinder } = require("mineflayer-pathfinder");
const { promisify } = require("util");
const FindTree = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/findtree.js");
const processStump = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/choptree.js");
const idle = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/idle.js");
const { createInterface } = require("readline");
const followentity = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/followentity.js");
const mineBelow = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/minetest.js");
const lumberjack = require("./hive/src/tasks/lumberjack3.js")
const sleep = promisify(setTimeout);

const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');

// Create HTTP server to serve the HTML file
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile('index.html', (err, data) => {
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        });
    }
});

// Create WebSocket server
const wsServer = new WebSocketServer({ server });

// Handle WebSocket connections
wsServer.on('connection', (ws) => {
    console.log('Client connected');
    
    ws.on('message', (message) => {
        const command = message.toString();
        switch (command) {
            case "chop": hiveMind.root.updates[0].trigger(); break;
            case "stop": hiveMind.root.updates[1].trigger(); break;
            case "move": hiveMind.root.updates[3].trigger(); break;
            case "mine": hiveMind.root.updates[4].trigger(); break;
        }
    });
});

// Start server
server.listen(8000, () => {
    console.log('Server running on http://localhost:8000');
});


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
        child: lumberjack,
        name: "idleToLumberjack",
    }),
    new changetask({
        parent: lumberjack,
        child: idle,
        name: "LumberjackToIdle",
    }),
    new changetask({
        parent: idle,
        child: followentity,
        name: "idleToFollow",
    }),
    new changetask({
        parent: idle,
        child: mineBelow,
        name: "idleToMine",
    }),
];

const test = new groupmanager({
    stateName: "root",
    bots: bots,
    autonomous: false,
    ignoreBusy: false,
    enter: idle,
    updates: updates,
    data: {
        stumps: [],
    }
});

async function main() {
    for (let i = 0; i < 3; i++) {
        const bot = createBot({
            username: `tree${i}`,
            host: "159.54.167.2",
            version: "1.21.1",
            port: 25567,
        });
        bot.loadPlugin(pathfinder);
        bots.push(bot);
        await sleep(1000);
    }
    hiveMind = new manager(bots, test);
}

rl.on("line", (input) => {
    const split = input.split(" ");
    switch (split[0]) {
        case "chop":
            hiveMind.root.updates[0].trigger();
            break;
        case "stop":
            hiveMind.root.updates[1].trigger();
            break;
        case "move":
            hiveMind.root.updates[3].trigger();
            break;
        case "mine":
            hiveMind.root.updates[4].trigger();
            break;


    }
});

async function report() {
    while (debug) {
        if (hiveMind) {
            console.log(hiveMind.root.activeStateType);
        }
        await sleep(1000);
    }
}

main();
report();