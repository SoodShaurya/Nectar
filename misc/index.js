const fs = require('fs')
const mineflayer = require('mineflayer')

// Function to create a bot from a single account with a Promise
function createBotFromAccount(account, delay = 0) {
  return new Promise((resolve, reject) => {
    const [username, password] = account.trim().split(':')
  
    const options = {
      host: 'sped.soods.co', // Change this to the IP you want
      port: 25565, // Change this to the port you want
      auth: 'microsoft',
      username: username,
      password: password
    }

    // Use setTimeout to introduce a delay before creating the bot
    setTimeout(() => {
      try {
        const bot = mineflayer.createBot(options)

        // Basic event listeners
        bot.on('login', () => {
          console.log(`Bot ${username} logged in successfully`)
          resolve(bot)
        })

        bot.on('error', (err) => {
          console.error(`Error with bot ${username}:`, err)
          resolve(null)
        })
      } catch (err) {
        console.error(`Failed to create bot for ${username}:`, err)
        resolve(null)
      }
    }, delay)
  })
}

// Read and process accounts with sequential loading
async function loadBotsFromFile(filePath, cooldown = 5000) {
  try {
    // Read the file synchronously
    const fileContents = fs.readFileSync(filePath, 'utf8')
    
    // Split the file contents into lines
    const accounts = fileContents.trim().split('\n')
    
    // Create bots sequentially with cooldown
    const bots = []
    for (let i = 0; i < accounts.length; i++) {
      // Calculate delay: first bot immediate, subsequent bots with increasing cooldown
      const delay = i * cooldown
      console.log(`Attempting to create bot for account ${i + 1} with ${delay}ms delay`)
      
      const bot = await createBotFromAccount(accounts[i], delay)
      if (bot) bots.push(bot)
    }

    console.log(`Successfully loaded ${bots.length} bots`)
    return bots
  } catch (err) {
    console.error('Error reading accounts file:', err)
    return []
  }
}

// Load bots from accs.txt
async function initializeBots() {
  const bots = await loadBotsFromFile('accs.txt',3000)
  // You can add additional setup or actions for the bots here
}

// Call the async function to start bot initialization
initializeBots().catch(console.error)