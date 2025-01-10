const fs = require('fs');
const { get } = require('http');
const mineflayer = require('mineflayer');
const readline = require('readline');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

// Global Configuration
const MAIN_PLAYER = 'SlideShows';
let radius = 3;
let rotationSpeed = 0.2;
let angle = 0;
const ATTACK_RANGE = 4;
let debugMode = true;
let UserToAttack = null;
let isAttackMode = false;
const ATTACK_COOLDOWN = 750;

// Initialize readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Utility Functions
function debugLog(bot, message) {
    if (debugMode) {
        console.log(`[${bot.username}] DEBUG: ${message}`);
    }
}

function inspectEntity(entity) {
    return {
        name: entity.displayName,
        type: entity.type,
        mobType: entity.mobType,
        isValid: entity.isValid,
        metadata: entity.metadata,
        entityType: entity.entityType
    };
}

function waitForEnter(message) {
    return new Promise((resolve) => {
        rl.question(message, () => {
            resolve();
        });
    });
}
async function createBotsWithChatControl(filePath) {
    try {
        const fileContents = fs.readFileSync(filePath, 'utf8');
        const accounts = fileContents.trim().split('\n');
        const bots = [];
        
        for (const account of accounts) {
            const [username, password] = account.trim().split(':');
            
            await waitForEnter(`Press Enter to spawn bot: ${username}`);
            
            const options = {
                host: "localhost",
                port: 25568,
                auth: 'microsoft',
                username: username,
                password: password,
                skipValidation: true,
                version: false,
                checkTimeoutInterval: 60000,
                closeTimeout: 120000
            };
            
            try {
                const bot = mineflayer.createBot(options);
                bot.loadPlugin(pathfinder);
                bot.isGuarding = false;
                bot.attackIndex = bots.length;
                
                bot.once('spawn', () => {
                    const defaultMove = new Movements(bot);
                    let lastAttackTime = 0;

                    // Combat System
                    setInterval(() => {
                        try {
                            const entities = Object.values(bot.entities);
                            const currentTime = Date.now();
                            
                            const staggerOffset = (bot.attackIndex * (ATTACK_COOLDOWN / bots.length)) % ATTACK_COOLDOWN;
                            const adjustedTime = currentTime - staggerOffset;
                            
                            const nearbyTargets = entities.filter(entity => {
                                if (!entity) return false;
                                
                                const distance = entity.position.distanceTo(bot.entity.position);
                                
                                // Player targeting
                                if (entity.type === 'player' && entity.username !== MAIN_PLAYER) {
                                    if (bots.some(b => b.username === entity.username)) return false;
                                    return distance <= ATTACK_RANGE;
                                }
                                
                                // Hostile mob targeting
                                const isHostile = entity.type === 'hostile';
                                return isHostile && distance <= ATTACK_RANGE;
                            });
                            
                            if (nearbyTargets.length > 0) {
                                const nearest = nearbyTargets.reduce((prev, current) => {
                                    const prevDist = prev.position.distanceTo(bot.entity.position);
                                    const currentDist = current.position.distanceTo(bot.entity.position);
                                    return prevDist < currentDist ? prev : current;
                                });
                                
                                bot.lookAt(nearest.position.offset(0, nearest.height * 0.5, 0), true);
                                
                                if (adjustedTime - lastAttackTime >= ATTACK_COOLDOWN) {
                                    debugLog(bot, `Attacking target: ${nearest.displayName || nearest.username} at distance ${nearest.position.distanceTo(bot.entity.position).toFixed(2)}`);
                                    bot.attack(nearest);
                                    lastAttackTime = adjustedTime;
                                }
                            }
                        } catch (err) {
                            console.error(`[${bot.username}] Error in combat cycle:`, err);
                        }
                    }, 50);


                    // Continue inside the bot.once('spawn', () => { ... }) from previous section

                    bot.on('chat', function(sender, message) {
                        if (sender === bot.username) return;
                        
                        const target = bot.players[sender]?.entity;

                        switch(message.toLowerCase()) {
                            case 'come':
                                if (!target) {
                                    bot.chat('I don\'t see you!');
                                    return;
                                }
                                const p = target.position;
                                bot.pathfinder.setMovements(defaultMove);
                                bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 1));
                                break;

                            case 'guard':
                                bot.isGuarding = !bot.isGuarding;
                                isAttackMode = false;
                                if (bot.isGuarding) {
                                    bot.chat(`Starting guard formation!`);
                                    console.log(`[${bot.username}] Guard mode ON`);
                                } else {
                                    bot.chat(`Stopping guard formation!`);
                                    bot.clearControlStates();
                                    console.log(`[${bot.username}] Guard mode OFF`);
                                }
                                break;

                            case 'closer':
                                radius = Math.max(2, radius - 1);
                                bot.chat(`Adjusting radius to ${radius}`);
                                break;

                            case 'farther':
                                radius += 1;
                                bot.chat(`Adjusting radius to ${radius}`);
                                break;

                            case 'slower':
                                rotationSpeed = Math.max(0.01, rotationSpeed - 0.01);
                                bot.chat(`Adjusting rotation speed to ${rotationSpeed}`);
                                break;

                            case 'faster':
                                rotationSpeed += 0.01;
                                bot.chat(`Adjusting rotation speed to ${rotationSpeed}`);
                                break;

                            default:
                                if (message.toLowerCase().startsWith('sa ')) {
                                    UserToAttack = message.split(' ')[1];
                                    isAttackMode = true;
                                    bot.isGuarding = false;
                                    bot.chat(`Surrounding and attacking ${UserToAttack}`);
                                } else if (message.toLowerCase() === 'stop') {
                                    isAttackMode = false;
                                    UserToAttack = null;
                                    bot.chat('Stopping attack');
                                }
                        }
                    });

                    bot.on('physicsTick', () => {
                        if (!bot.isGuarding && !isAttackMode) {
                            bot.setControlState('forward', false);
                            bot.setControlState('sprint', true);
                            return;
                        }

                        let targetPlayer;
                        if (isAttackMode) {
                            targetPlayer = bot.players[UserToAttack];
                        } else if (bot.isGuarding) {
                            targetPlayer = bot.players[MAIN_PLAYER];
                        }

                        if (!targetPlayer || !targetPlayer.entity) {
                            if (isAttackMode) {
                                console.log(`[${bot.username}] Cannot find target player ${UserToAttack}`);
                            } else {
                                console.log(`[${bot.username}] Cannot find player ${MAIN_PLAYER}`);
                            }
                            return;
                        }

                        // Position prediction and movement calculation
                        const centerPos = targetPlayer.entity.position;
                        const playerVelocity = targetPlayer.entity.velocity;
                        
                        const predictionFactor = isAttackMode ? 5 : 10;
                        const predictedPos = {
                            x: centerPos.x + (playerVelocity.x * predictionFactor),
                            y: centerPos.y,
                            z: centerPos.z + (playerVelocity.z * predictionFactor)
                        };

                        const botIndex = bots.indexOf(bot);
                        const spacing = (2 * Math.PI) / bots.length;
                        const currentAngle = angle + spacing * botIndex;

                        const currentRadius = isAttackMode ? 2 : radius;

                        const targetX = predictedPos.x + currentRadius * Math.cos(currentAngle);
                        const targetZ = predictedPos.z + currentRadius * Math.sin(currentAngle);

                        const dx = targetX - bot.entity.position.x;
                        const dz = targetZ - bot.entity.position.z;

                        const distance = Math.sqrt(dx * dx + dz * dz);
                        
                        const baseSpeed = isAttackMode ? 1.0 : 0.8;
                        const speedMultiplier = Math.min(distance / 2, 1.5);
                        const speed = baseSpeed * speedMultiplier;

                        // Advanced movement and stepping system
                        if (distance > 0.1) {
                            const stepHeight = 1.0;
                            const botPos = bot.entity.position;
                            const moveDir = { x: dx / distance, z: dz / distance };
                            
                            // Block detection for stepping
                            const block = bot.world.getBlock(
                                bot.entity.position.offset(moveDir.x, 0, moveDir.z)
                            );
                            
                            const blockAbove = bot.world.getBlock(
                                bot.entity.position.offset(moveDir.x, 1, moveDir.z)
                            );

                            // Stepping logic
                            if (block && block.boundingBox !== 'empty' && (!blockAbove || blockAbove.boundingBox === 'empty')) {
                                const blockTop = Math.floor(block.position.y) + 1;
                                const heightDiff = blockTop - botPos.y;
                                
                                if (heightDiff > 0 && heightDiff <= stepHeight) {
                                    bot.entity.velocity.y = 0.2;
                                }
                            }

                            // Apply movement
                            bot.entity.velocity.x = (dx / distance) * speed;
                            bot.entity.velocity.z = (dz / distance) * speed;
                        } else {
                            bot.entity.velocity.x = 0;
                            bot.entity.velocity.z = 0;
                        }

                        // Target tracking
                        if (isAttackMode) {
                            bot.lookAt(targetPlayer.entity.position.offset(0, targetPlayer.entity.height * 0.5, 0), true);
                        }
                    });
                    

                

                    // Initialize bot state
                    console.log(`Bot ${username} spawned and ready`);
                });
                
                // Error handling
                bot.on('error', err => {
                    console.error(`[${username}] Error:`, err);
                });

                bot.on('kicked', reason => {
                    console.log(`[${username}] Kicked:`, reason);
                });

                bot.on('end', () => {
                    console.log(`[${username}] Disconnected`);
                });

                bots.push(bot);
                
                // Delay between bot spawns
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (err) {
                console.error(`Failed to create bot for ${username}:`, err);
            }
        }
        
        return bots;
        
    } catch (err) {
        console.error('Error reading accounts file:', err);
        rl.close();
        return [];
    }
}

// Formation update interval
function startFormationUpdates(bots) {
    setInterval(() => {
        if (bots.some(bot => bot.isGuarding) || isAttackMode) {
            angle += rotationSpeed;
            if (angle > Math.PI * 2) angle -= Math.PI * 2;
        }
    }, 100);
}

// Main initialization function
async function initializeBots() {
    try {
        console.log('Starting bot initialization...');
        console.log('Reading accounts from accs.txt...');
        
        // Validate accounts file exists
        if (!fs.existsSync('../accs.txt')) {
            console.error('Error: accs.txt file not found!');
            console.log('Please create accs.txt with format username:password on each line');
            process.exit(1);
        }

        // Initialize bots
        const bots = await createBotsWithChatControl('../accs.txt');
        
        if (bots.length === 0) {
            console.error('No bots were successfully created. Exiting...');
            process.exit(1);
        }

        console.log(`Successfully initialized ${bots.length} bots`);
        
        // Start formation updates
        startFormationUpdates(bots);

        // Setup process termination handling
        process.on('SIGINT', async () => {
            console.log('\nGracefully shutting down...');
            for (const bot of bots) {
                try {
                    await bot.quit();
                } catch (err) {
                    console.error(`Error disconnecting bot ${bot.username}:`, err);
                }
            }
            rl.close();
            process.exit(0);
        });

        // Command help
        console.log('\nAvailable commands in game:');
        console.log('- guard: Toggle guard formation');
        console.log('- come: Make bots come to you');
        console.log('- sa <player>: Surround and attack specified player');
        console.log('- stop: Stop current attack');
        console.log('- closer/farther: Adjust formation radius');
        console.log('- slower/faster: Adjust rotation speed');
        
        return bots;

    } catch (err) {
        console.error('Fatal error during initialization:', err);
        rl.close();
        process.exit(1);
    }
}

// Error handling for uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot system
console.log('Bot system starting...');
console.log('Make sure your Minecraft server is running and accs.txt is properly configured.');

initializeBots().then(() => {
    console.log('Bot system fully initialized and running.');
}).catch(err => {
    console.error('Failed to initialize bot system:', err);
    process.exit(1);
});