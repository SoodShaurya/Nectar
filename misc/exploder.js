const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder').pathfinder
const Movements = require('mineflayer-pathfinder').Movements
const { GoalNear } = require('mineflayer-pathfinder').goals

const serverAddress = '159.54.167.2';  // Replace with your server address
const serverPort = 25567;  // Default Minecraft port, change if necessary

// Bot settings
const botCount = 20;  // Number of bots to create

function createBot() {
  const bot = mineflayer.createBot({
    host: serverAddress,
    port: serverPort,
    username: 'hateniggers' + Math.floor(Math.random() * 10000),  // Generate a random bot name
    version: "1.21.1",  // Auto detect the version
  });

  bot.loadPlugin(pathfinder)



  bot.on('spawn', () => {
    const defaultMove = new Movements(bot)

    console.log(`Bot ${bot.username} spawned`);

    bot.on('chat', function(username, message) {
  
        if (username === bot.username) return
    
        const target = bot.players[username] ? bot.players[username].entity : null
        if (message === 'come') {
          if (!target) {
            bot.chat('I don\'t see you !')
            return
          }
          const p = target.position
    
          bot.pathfinder.setMovements(defaultMove)
          bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 1))
        } 
      })

  });
  

  bot.on('error', (err) => {
    console.log(`Error with bot ${bot.username}: ${err}`);
  });

  bot.on('end', () => {
    console.log(`Bot ${bot.username} disconnected`);
  });
}

// Spawn the bots
for (let i = 0; i < botCount; i++) {
  createBot();
}
