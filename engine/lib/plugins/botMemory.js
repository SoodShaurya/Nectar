const { Vec3 } = require('vec3'); // Assuming vec3 is available, common in mineflayer projects

const DEFAULT_UPDATE_INTERVAL = 1000; // ms - How often to scan for nearby entities
const DEFAULT_NEARBY_RADIUS = 32; // blocks - Radius to scan for entities

class BotMemory {
  constructor(bot) {
    this.bot = bot;
    this.nearbyEntities = {}; // { id: { entity: entityRef, type: 'player'|'mob'|'object'|'other', position: Vec3, distance: number } }
    this.botDistances = {}; // { botId: distance }
    this.currentActivity = null; // String name of the current activity
    this.targetCoordinates = null; // Vec3 | null - Target for pathfinding or other activities
    this.updateIntervalId = null;
    this.nearbyRadius = DEFAULT_NEARBY_RADIUS;
  }

  /**
   * Starts the periodic update process for nearby entities.
   * Should be called by botManager after the bot spawns.
   */
  startUpdating() {
    if (this.updateIntervalId) {
      this.stopUpdating();
    }
    this._updateNearbyEntities(); // Initial update
    this.updateIntervalId = setInterval(() => {
      this._updateNearbyEntities();
    }, DEFAULT_UPDATE_INTERVAL);
    console.log(`[BotMemory ${this.bot.username}] Started entity updates.`);
  }

  /**
   * Stops the periodic update process.
   * Should be called by botManager when the bot is deleted or ends.
   */
  stopUpdating() {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
      console.log(`[BotMemory ${this.bot.username}] Stopped entity updates.`);
    }
  }

  /**
   * Internal method to scan and update the list of nearby entities.
   */
  _updateNearbyEntities() {
    if (!this.bot.entity) return; // Bot might not be spawned yet

    const newNearbyEntities = {};
    const botPos = this.bot.entity.position;

    for (const entityId in this.bot.entities) {
      const entity = this.bot.entities[entityId];
      if (entity === this.bot.entity) continue; // Skip self

      const distance = botPos.distanceTo(entity.position);
      if (distance <= this.nearbyRadius) {
        newNearbyEntities[entity.id] = {
          entity: entity, // Keep reference for direct access if needed
          id: entity.id,
          uuid: entity.uuid, // Useful for players
          type: entity.type, // 'player', 'mob', 'object', etc.
          name: entity.name, // Mob type or object name
          username: entity.username, // Player username
          position: entity.position.clone(), // Clone to avoid mutation issues
          distance: distance,
        };
      }
    }
    this.nearbyEntities = newNearbyEntities;
    // console.log(`[BotMemory ${this.bot.username}] Updated nearby entities: ${Object.keys(this.nearbyEntities).length}`); // Optional: for debugging
  }

  /**
   * Internal method called by botManager to update the current activity.
   * @param {string | null} activityName - The name of the new activity, or null.
   */
  _setActivity(activityName) {
    this.currentActivity = activityName;
    console.log(`[BotMemory ${this.bot.username}] Activity set to: ${activityName}`);
  }

  /**
   * Internal method called by botManager to update distances to other bots.
   * @param {object} distancesMap - An object mapping botId to distance { botId1: dist1, botId2: dist2, ... }
   */
  _updateBotDistances(distancesMap) {
    this.botDistances = distancesMap;
    // console.log(`[BotMemory ${this.bot.username}] Updated bot distances:`, this.botDistances); // Optional: for debugging
  }

  // --- Public Accessors ---

  /**
   * Gets the map of nearby entities.
   * @returns {object} The nearbyEntities map.
   */
  getNearbyEntities() {
    return this.nearbyEntities;
  }

  /**
   * Gets the map of distances to other known bots.
   * @returns {object} The botDistances map.
   */
  getBotDistances() {
    return this.botDistances;
  }

  /**
   * Gets the name of the current activity.
   * @returns {string | null} The current activity name.
   */
  getCurrentActivity() {
    return this.currentActivity;
  }

  /**
   * Sets the radius for nearby entity scanning.
   * @param {number} radius - The new radius in blocks.
   */
  setNearbyRadius(radius) {
    this.nearbyRadius = Math.max(0, radius); // Ensure radius is not negative
    console.log(`[BotMemory ${this.bot.username}] Nearby radius set to: ${this.nearbyRadius}`);
    this._updateNearbyEntities(); // Update immediately with the new radius
  }

  /**
   * Sets the target coordinates in the bot's memory.
   * @param {Vec3 | null} coords - The target coordinates (Vec3) or null to clear.
   */
  setTargetCoordinates(coords) {
    // Removed instanceof Vec3 check as botManager ensures type before calling.
    // We expect coords to be either a Vec3 object or null.
    this.targetCoordinates = coords ? coords.clone() : null; // Clone to prevent external mutation
    // console.log(`[BotMemory ${this.bot.username}] Target coordinates set to:`, this.targetCoordinates); // Optional: for debugging
  }

  /**
   * Gets the target coordinates from the bot's memory.
   * @returns {Vec3 | null} The target coordinates (Vec3) or null if not set.
   */
  getTargetCoordinates() {
    return this.targetCoordinates;
  }
}

// The main plugin function injected into Mineflayer
function inject(bot) {
  bot.memory = new BotMemory(bot);
}

module.exports = inject;
