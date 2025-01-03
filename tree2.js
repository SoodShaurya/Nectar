const { createBot } = require("mineflayer");
const { CentralHiveMind: manager } = require("/Users/shaurya/Documents/dev/bot/hive/src/brain/manager.js");
const { changetask } = require("/Users/shaurya/Documents/dev/bot/hive/src/brain/statemachine.js");
const { groupmanager } = require("/Users/shaurya/Documents/dev/bot/hive/src/brain/groupmanager.js");
const { pathfinder } = require("mineflayer-pathfinder");
const { promisify } = require("util");
const idle = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/idle.js");
const lumberjack = require("./hive/src/tasks/lumberjack3.js");
const followentity = require("/Users/shaurya/Documents/dev/bot/hive/src/tasks/followentity.js");
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');

const sleep = promisify(setTimeout);
const bots = [];
const groups = {};
const managers = {};

// Create base updates for state transitions
const baseUpdates = [
    new changetask({
        parent: idle,
        child: lumberjack,
        name: "idleToLumberjack"
    }),
    new changetask({
        parent: lumberjack,
        child: idle,
        name: "LumberjackToIdle"
    }),
    new changetask({
        parent: idle,
        child: followentity,
        name: "idleToFollow"
    }),
    new changetask({
        parent: followentity,
        child: idle,
        name: "followToIdle"
    })
];

// Create initial main group
const mainGroup = new groupmanager({
    stateName: "main",
    bots: bots,
    autonomous: false,
    ignoreBusy: false,
    enter: idle,
    updates: baseUpdates,
    data: { stumps: [] }
});

groups["main"] = mainGroup;

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile('index.html', (err, data) => {
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        });
    }
});

const wsServer = new WebSocketServer({ server });

function updateClientGroups(ws) {
    try {
        const groupInfo = {};
        for (const [groupName, group] of Object.entries(groups)) {
            groupInfo[groupName] = {
                botCount: group.bots.length,
                bots: group.bots.map(bot => bot.username),
                state: group.activeStateType?.name || 'idle'
            };
        }
        ws.send(JSON.stringify({
            action: 'updateGroups',
            groups: groupInfo
        }));
    } catch (err) {
        console.log("Error sending group update:", err);
    }
}

wsServer.on('connection', (ws) => {
    console.log('Client connected');
    ws.isAlive = true;
    updateClientGroups(ws);
    
    const interval = setInterval(() => {
        if (ws.isAlive === false) {
            clearInterval(interval);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
        updateClientGroups(ws);
    }, 1000);
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch(data.action) {
            case 'changeState':
                const tgtGrp = groups[data.groupName];
                const tgtManager = managers[data.groupName];
                if (tgtGrp && tgtManager) {
                    console.log(`Changing state for group ${data.groupName} to ${data.state}`);
                    if (data.state === 'lumberjack') {
                        tgtManager.root.updates[0].trigger();
                    } else if (data.state === 'idle') {
                        tgtManager.root.updates[1].trigger();
                    } else if (data.state === 'follow') {
                        tgtManager.root.updates[2].trigger();
                    }
                    updateClientGroups(ws);
                }
                break;
            case 'createGroup':
                console.log(`Creating new group: ${data.groupName}`);
                // Get one bot from main group
                const mainBots = groups["main"].getUsableBots();
                if (mainBots.length === 0) {
                    console.log("No available bots in main group to assign to new group");
                    return;
                }
                
                const botToMove = mainBots.slice(0, 1);
                
                // Create new group with the bot
                const newGroup = new groupmanager({
                    stateName: data.groupName,
                    bots: botToMove,
                    autonomous: false,
                    ignoreBusy: false,
                    enter: idle,
                    updates: [
                        new changetask({
                            parent: idle,
                            child: lumberjack,
                            name: "idleToLumberjack"
                        }),
                        new changetask({
                            parent: lumberjack,
                            child: idle,
                            name: "LumberjackToIdle"
                        }),
                        new changetask({
                            parent: idle,
                            child: followentity,
                            name: "idleToFollow"
                        }),
                        new changetask({
                            parent: followentity,
                            child: idle,
                            name: "followToIdle"
                        })
                    ],
                    data: { stumps: [] }
                });
                
                // Remove bot from main group
                const index = groups["main"].bots.indexOf(botToMove[0]);
                if (index !== -1) {
                    groups["main"].bots.splice(index, 1);
                }
                
                groups[data.groupName] = newGroup;
                managers[data.groupName] = new manager(botToMove, newGroup);
                updateClientGroups(ws);
                break;
                
                
            case 'moveBots':
                const sourceGroup = groups[data.from];
                const targetGroup = groups[data.to];
                if (sourceGroup && targetGroup) {
                    const botsToMove = sourceGroup.getUsableBots().slice(0, data.count);
                    
                    if (sourceGroup.activeStateType) {
                        sourceGroup.exitStates({
                            stateName: sourceGroup.activeStateType.name,
                            autonomous: false
                        });
                    }
                    
                    botsToMove.forEach(bot => {
                        const index = sourceGroup.bots.indexOf(bot);
                        if (index !== -1) {
                            sourceGroup.bots.splice(index, 1);
                        }
                    });
                    
                    targetGroup.bots.push(...botsToMove);
                    if (botsToMove.length > 0) {
                        targetGroup.enterStates(idle, ...botsToMove);
                        managers[data.to] = new manager(targetGroup.bots, targetGroup);
                    }
                    updateClientGroups(ws);
                }
                break;
        }
    });
});

async function initializeBots() {
    console.log('Initializing bots...');
    for (let i = 0; i < 3; i++) {
        const bot = createBot({
            username: `bot${i}`,
            host: "159.54.167.2",
            version: "1.21.1",
            port: 25567,
        });
        bot.loadPlugin(pathfinder);
        bots.push(bot);
        console.log(`Created bot${i}`);
        await sleep(1000);
    }
    managers["main"] = new manager(bots, mainGroup);
    console.log('Main hivemind created');
}

server.listen(8000, () => {
    console.log('Server running on http://localhost:8000');
    initializeBots();
});
