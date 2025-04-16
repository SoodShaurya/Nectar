// Activity: stand_still.js
// Does nothing, keeps the bot idle.

function load(bot) {
  console.log(`[${bot.username}] Activity loaded: stand_still`);
  // No specific action needed to stand still.
  // No interval needed.
}

function unload(bot) {
  console.log(`[${bot.username}] Activity unloaded: stand_still`);
  // No specific action needed to stop standing still.
}

module.exports = {
  load,
  unload
};
