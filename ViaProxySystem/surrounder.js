const fs = require('fs');
const { get } = require('http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const {createBot} = require('mineflayer-viaproxy')


const MAIN_PLAYER = 'SlideShows';
let radius = 3; // Made adjustable
let rotationSpeed = 0.2; // Made adjustable
let angle = 0;
const ATTACK_RANGE = 4;
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
        host: 'b2studios.aternos.me',
        port: 25565,
        auth: 'microsoft',
        username: username,
        password: password,
        skipValidation: true,
        version: false,
        checkTimeoutInterval: 60000,
        closeTimeout: 120000
      };
      
      try {
        const bot = createBot(options);
        bot.loadPlugin(pathfinder);
        bot.isGuarding = false;
        
        bot.once('spawn', () => {
          const defaultMove = new Movements(bot);

          // Add killaura functionality
          let attackPlayers = true; // Toggle for attacking players

          setInterval(() => {
            try {
              const entities = Object.values(bot.entities);
          
              // Filter for hostile mobs and players (if attackPlayers is enabled)
              
              const nearbyTargets = entities.filter(entity => {
                if (!entity) return false;
          
                const distance = entity.position.distanceTo(bot.entity.position);
                if (attackPlayers && entity.type === 'player' && entity.username !== MAIN_PLAYER) {
                    if (bots.some(b => b.username === entity.username)) return false;
                  return distance <= ATTACK_RANGE; // Include players except MAIN_PLAYER
                }
          
                const isHostile = entity.type === 'hostile'; // Check for hostile type
                return isHostile && distance <= ATTACK_RANGE;
              });
          
              if (nearbyTargets.length > 0) {
                // Find the nearest target
                const nearest = nearbyTargets.reduce((prev, current) => {
                  const prevDist = prev.position.distanceTo(bot.entity.position);
                  const currentDist = current.position.distanceTo(bot.entity.position);
                  return prevDist < currentDist ? prev : current;
                });
          
                debugLog(bot, `Attacking target: ${nearest.displayName || nearest.username} at distance ${nearest.position.distanceTo(bot.entity.position).toFixed(2)}`);
          
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
            if (!bot.isGuarding) {
              bot.setControlState('forward', false);
              bot.setControlState('sprint', true);
              return;
            }
          
            const player = bot.players[MAIN_PLAYER];
            if (!player || !player.entity) {
              console.log(`[${bot.username}] Cannot find player ${MAIN_PLAYER}`);
              return;
            }
          
            const centerPos = player.entity.position;
            const botIndex = bots.indexOf(bot);
            const spacing = (2 * Math.PI) / bots.length;
          
            const currentAngle = angle + spacing * botIndex;
          
            // Calculate circular path target
            const targetX = centerPos.x + radius * Math.cos(currentAngle);
            const targetZ = centerPos.z + radius * Math.sin(currentAngle);
          
            // Calculate velocity for circular motion
            const dx = targetX - bot.entity.position.x;
            const dz = targetZ - bot.entity.position.z;
          
            // Normalize the direction to get constant speed
            const distance = Math.sqrt(dx * dx + dz * dz);
            const speed = 0.5; // Adjust speed here
          
            if (distance > 0.1) {
              bot.entity.velocity.x = (dx / distance) * speed;
              bot.entity.velocity.z = (dz / distance) * speed;
            } else {
              bot.entity.velocity.x = 0;
              bot.entity.velocity.z = 0;
            }
          
            // Detect mobs and attack them
            const entities = Object.values(bot.entities);
            const nearbyMobs = entities.filter(entity => {
              if (!entity) return false;
              const mobDistance = entity.position.distanceTo(bot.entity.position);
              const isHostile = entity.type === 'hostile';
              return isHostile && mobDistance <= ATTACK_RANGE;
            });
          
            if (nearbyMobs.length > 0) {
              const nearest = nearbyMobs.reduce((prev, current) => {
                const prevDist = prev.position.distanceTo(bot.entity.position);
                const currentDist = current.position.distanceTo(bot.entity.position);
                return prevDist < currentDist ? prev : current;
              });
              
              bot.lookAt(nearest.position.offset(0, nearest.height * 0.5, 0), true);
              bot.attack(nearest);

            }
          });
          
          
          
          
          console.log(`Bot ${username} spawned and ready`);
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