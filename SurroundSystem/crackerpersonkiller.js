const fs = require('fs');
const { get } = require('http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

const MAIN_PLAYER = 'SlideShows';
let radius = 3;
let rotationSpeed = 0.2;
let angle = 0;
const ATTACK_RANGE = 4;
let debugMode = true;
let UserToAttack = null;
let isAttackMode = false;

// Function to generate random username
function generateRandomUsername() {
    const prefix = 'Bot_';
    const randomNum = Math.floor(Math.random() * 10000);
    return prefix + randomNum;
}

function getRandomDelay(min = 3000, max = 7000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

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

async function createBotsWithChatControl(numberOfBots = 5) {
    try {
        const bots = [];
        
        for (let i = 0; i < numberOfBots; i++) {
            const username = generateRandomUsername();
            
            const options = {
                host: '159.54.167.2',
                port: 25567,
                username: username,
                auth: 'offline',
                version: '1.21.1',
                checkTimeoutInterval: 60000,
                closeTimeout: 120000
            };
            
            try {
                const bot = mineflayer.createBot(options);
                bot.loadPlugin(pathfinder);
                bot.isGuarding = false;
                
                bot.once('spawn', () => {
                    const defaultMove = new Movements(bot);
                
                    let attackPlayers = true;
                    let lastAttackTime = 0;
                    const ATTACK_COOLDOWN = 750; // Adjustable cooldown in milliseconds (0.75 seconds default)
                    bot.attackIndex = bots.length; // Give each bot a unique attack index

                    
                    setInterval(() => {
                        try {
                            const entities = Object.values(bot.entities);
                            const currentTime = Date.now();
                            
                            // Stagger attacks based on bot index
                            const staggerOffset = (bot.attackIndex * (ATTACK_COOLDOWN / bots.length)) % ATTACK_COOLDOWN;
                            const adjustedTime = currentTime - staggerOffset;
                            
                            const nearbyTargets = entities.filter(entity => {
                                if (!entity) return false;
                                
                                const distance = entity.position.distanceTo(bot.entity.position);
                                if (attackPlayers && entity.type === 'player' && entity.username !== MAIN_PLAYER) {
                                    if (bots.some(b => b.username === entity.username)) return false;
                                    return distance <= ATTACK_RANGE;
                                }
                                
                                const isHostile = entity.type === 'hostile';
                                return isHostile && distance <= ATTACK_RANGE;
                            });
                            
                            if (nearbyTargets.length > 0) {
                                const nearest = nearbyTargets.reduce((prev, current) => {
                                    const prevDist = prev.position.distanceTo(bot.entity.position);
                                    const currentDist = current.position.distanceTo(bot.entity.position);
                                    return prevDist < currentDist ? prev : current;
                                });
                                
                                // Look at target regardless of cooldown
                                bot.lookAt(nearest.position.offset(0, nearest.height * 0.5, 0), true);
                                
                                // Only attack if cooldown has expired
                                if (adjustedTime - lastAttackTime >= ATTACK_COOLDOWN) {
                                    debugLog(bot, `Attacking target: ${nearest.displayName || nearest.username} at distance ${nearest.position.distanceTo(bot.entity.position).toFixed(2)}`);
                                    bot.attack(nearest);
                                    lastAttackTime = adjustedTime;
                                }
                            }
                            
                        } catch (err) {
                            console.error(`[${bot.username}] Error in mob detection cycle:`, err);
                        }
                    }, 50);

                    bot.on('chat', function(sender, message) {
                        if (sender === bot.username) return;
                        
                        const target = bot.players[sender]?.entity;
        
                        if (message === 'come') {
                            if (!target) {
                                bot.chat('I don\'t see you!');
                                return;
                            }
                            const p = target.position;
                            bot.pathfinder.setMovements(defaultMove);
                            bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 1));
                        }
        
                        if (message.toLowerCase() === 'guard') {
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
                        }

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
        
                        if (message.toLowerCase() === 'closer') {
                            radius = Math.max(2, radius - 1);
                            bot.chat(`Adjusting radius to ${radius}`);
                        }
                        
                        if (message.toLowerCase() === 'farther') {
                            radius += 1;
                            bot.chat(`Adjusting radius to ${radius}`);
                        }
                        
                        if (message.toLowerCase() === 'slower') {
                            rotationSpeed = Math.max(0.01, rotationSpeed - 0.01);
                            bot.chat(`Adjusting rotation speed to ${rotationSpeed}`);
                        }
                        
                        if (message.toLowerCase() === 'faster') {
                            rotationSpeed += 0.01;
                            bot.chat(`Adjusting rotation speed to ${rotationSpeed}`);
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
                    
                        // Get player's current position and velocity
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
                    
                        if (distance > 0.1) {
                            // Check for blocks in front of the bot
                            const stepHeight = 1.0; // Maximum step height (1 block)
                            const botPos = bot.entity.position;
                            const moveDir = { x: dx / distance, z: dz / distance };
                            
                            // Check for blocks in the path
                            const block = bot.world.getBlock(
                                bot.entity.position.offset(moveDir.x, 0, moveDir.z)
                            );
                            
                            const blockAbove = bot.world.getBlock(
                                bot.entity.position.offset(moveDir.x, 1, moveDir.z)
                            );
                    
                            // If there's a block in front but not above, step up
                            if (block && block.boundingBox !== 'empty' && (!blockAbove || blockAbove.boundingBox === 'empty')) {
                                const blockTop = Math.floor(block.position.y) + 1;
                                const heightDiff = blockTop - botPos.y;
                                
                                if (heightDiff > 0 && heightDiff <= stepHeight) {
                                    bot.entity.velocity.y = 0.2; // Adjust this value to change step speed
                                }
                            }
                    
                            bot.entity.velocity.x = (dx / distance) * speed;
                            bot.entity.velocity.z = (dz / distance) * speed;
                        } else {
                            bot.entity.velocity.x = 0;
                            bot.entity.velocity.z = 0;
                        }
                    
                        // In attack mode, always look at the target
                        if (isAttackMode) {
                            bot.lookAt(targetPlayer.entity.position.offset(0, targetPlayer.entity.height * 0.5, 0), true);
                        }
                    });
                    
                    console.log(`Bot ${username} spawned and ready`);
                });
                
                bots.push(bot);
                
                const delay = 100;
                console.log(`Waiting ${delay}ms before next bot`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                
            } catch (err) {
                console.error(`Failed to create bot ${username}:`, err);
            }
        }
        
        console.log(`Successfully loaded ${bots.length} bots`);

        setInterval(() => {
            if (bots.some(bot => bot.isGuarding) || isAttackMode) {
                angle += rotationSpeed;
                if (angle > Math.PI * 2) angle -= Math.PI * 2;
            }
        }, 100);

        return bots;
        
    } catch (err) {
        console.error('Error creating bots:', err);
        return [];
    }
}

async function initializeBots() {
    const bots = await createBotsWithChatControl(10); // Create 5 bots
    return bots;
}

initializeBots().catch(console.error);