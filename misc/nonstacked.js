const fs = require('fs');
const { get } = require('http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

const MAIN_PLAYER = 'SlideShows';
let radius = 3; // Made adjustable
let rotationSpeed = 0.2; // Made adjustable
let angle = 0;
const ATTACK_RANGE = 3;
let debugMode = true; // Toggle for debug messages

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


async function createBotsWithChatControl(filePath) {
  try {
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const accounts = fileContents.trim().split('\n');
    
    const bots = [];
    
    for (const account of accounts) {
      const [username, password] = account.trim().split(':');
      
      const options = {
        host: '159.54.167.2',
        port: 25567,
        auth: 'microsoft',
        username: username,
        password: password,
        skipValidation: true,
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

          // Add killaura functionality
          setInterval(() => {
            try {
                const entities = Object.values(bot.entities);
                
                // Filter for hostile mobs
                const nearbyMobs = entities.filter(entity => {
                    if (!entity) return false;
                    
                    const distance = entity.position.distanceTo(bot.entity.position);
                    const isHostile = entity.type === 'hostile';  // Check for hostile type
                    
                    
                    return isHostile && distance <= ATTACK_RANGE;
                });
        
                if (nearbyMobs.length > 0) {
                    const nearest = nearbyMobs.reduce((prev, current) => {
                        const prevDist = prev.position.distanceTo(bot.entity.position);
                        const currentDist = current.position.distanceTo(bot.entity.position);
                        return prevDist < currentDist ? prev : current;
                    });
        
                    debugLog(bot, `Attacking hostile mob: ${nearest.displayName} at distance ${nearest.position.distanceTo(bot.entity.position).toFixed(2)}`);
                    
                    bot.lookAt(nearest.position.offset(0, nearest.height * 0.5, 0), true);
                    bot.attack(nearest);

                    
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
              if (bot.isGuarding) {
                bot.chat(`Starting guard formation!`);
                console.log(`[${bot.username}] Guard mode ON`);
              } else {
                bot.chat(`Stopping guard formation!`);
                bot.clearControlStates();
                console.log(`[${bot.username}] Guard mode OFF`);
              }
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

          let isMoving = false;
          
          bot.on('physicsTick', () => {
            if (!bot.isGuarding) return;
          
            const player = bot.players[MAIN_PLAYER];
            if (!player || !player.entity) return;
          
            const centerPos = player.entity.position;
            const botIndex = bots.indexOf(bot);
            const spacing = (2 * Math.PI) / bots.length;
          
            const currentAngle = angle + (spacing * botIndex);
          
            // Target position on the circle
            const targetX = centerPos.x + radius * Math.cos(currentAngle);
            const targetZ = centerPos.z + radius * Math.sin(currentAngle);
          
            // Calculate velocity to move smoothly toward the target position
            const dx = targetX - bot.entity.position.x;
            const dz = targetZ - bot.entity.position.z;
          
            const velocityFactor = 0.1; // Adjust for smoother/slower movement
            bot.entity.velocity.x = dx * velocityFactor;
            bot.entity.velocity.z = dz * velocityFactor;
          
            // Smoothly rotate the bot to face the center of the circle
            const yaw = Math.atan2(-dx, -dz);
            bot.look(yaw, bot.entity.pitch, true);
          
            // Combat Logic - Check for nearby hostile mobs
            const nearbyMobs = Object.values(bot.entities).filter(entity => {
              if (!entity) return false;
              const distance = entity.position.distanceTo(bot.entity.position);
              return entity.type === 'hostile' && distance <= ATTACK_RANGE; // Hostile mobs within attack range
            });
          
            if (nearbyMobs.length > 0) {
              // Attack the closest mob
              const targetMob = nearbyMobs.reduce((closest, current) => {
                const closestDist = closest.position.distanceTo(bot.entity.position);
                const currentDist = current.position.distanceTo(bot.entity.position);
                return currentDist < closestDist ? current : closest;
              });
          
              bot.lookAt(targetMob.position, true, () => {
                bot.attack(targetMob);
                debugLog(bot, `Attacking hostile mob: ${targetMob.displayName} at distance ${targetMob.position.distanceTo(bot.entity.position).toFixed(2)}`);
              });
            }
          });
          
          
          
          
          
          console.log(`Bot ${username} spawned and ready`);
        });
        
        bot.on('login', () => {
          console.log(`Bot ${username} logged in successfully`);
        });

        bot.on('error', (err) => {
          console.error(`[${bot.username}] Error:`, err);
        });

        bot.on('kicked', (reason) => {
          console.log(`[${bot.username}] Kicked:`, reason);
        });
        
        bots.push(bot);
        
        const delay = getRandomDelay();
        console.log(`Waiting ${delay}ms before next bot`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        
      } catch (err) {
        console.error(`Failed to create bot for ${username}:`, err);
      }
    }
    
    console.log(`Successfully loaded ${bots.length} bots`);

    setInterval(() => {
      if (bots.some(bot => bot.isGuarding)) {
        angle += rotationSpeed;
        if (angle > Math.PI * 2) angle -= Math.PI * 2;
      }
    }, 100);

    return bots;
    
  } catch (err) {
    console.error('Error reading accounts file:', err);
    return [];
  }
}

async function initializeBots() {
  const bots = await createBotsWithChatControl('accs.txt');
  return bots;
}

initializeBots().catch(console.error);


