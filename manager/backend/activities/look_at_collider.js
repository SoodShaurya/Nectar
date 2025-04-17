// Activity: look_at_collider.js
// Makes the bot look at the player named 'Collider'.

const LOOK_INTERVAL = 500; // ms between checks

function load(bot) {
  console.log(`[${bot.username}] Activity loaded: look_at_collider`);

  // Start an interval timer to periodically look for and at the player
  const intervalId = setInterval(() => {
    const targetPlayer = bot.players['Collider']; // Access player by username

    if (targetPlayer && targetPlayer.entity) {
      // Calculate the position to look at (player's head)
      const headPosition = targetPlayer.entity.position.offset(0, targetPlayer.entity.height, 0);
      bot.lookAt(headPosition);
    } else {
      // Optional: Log if the target is not found or has no entity yet
      // console.log(`[${bot.username}] Player 'Collider' not found or entity not available.`);
    }
  }, LOOK_INTERVAL);

  // Return the interval ID so the botManager can clear it when unloading
  return intervalId;
}

function unload(bot) {
  console.log(`[${bot.username}] Activity unloaded: look_at_collider`);
  // The interval is cleared by the botManager before this function is called.
  // Add any other cleanup specific to this activity if needed in the future.
}

module.exports = {
  load,
  unload
};
