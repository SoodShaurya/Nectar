const { Vec3 } = require('vec3'); // Assuming vec3 is available, common in mineflayer projects
const mcData = require('minecraft-data'); // Required for item checks

const DEFAULT_UPDATE_INTERVAL = 200; // ms - Faster updates for quicker reaction
const DEFAULT_NEARBY_RADIUS = 32; // blocks - Radius to scan for entities
const HOSTILITY_TIMEOUT = 5000; // ms - How long an attack makes someone hostile (5 seconds)

// Helper function to check if an item is a weapon
function isWeapon(item) {
  if (!item) return false;
  // Basic check - extend this list as needed
  const weaponNames = ['sword', 'axe', 'bow', 'crossbow', 'trident'];
  return weaponNames.some(name => item.name.includes(name));
}

// Helper function to calculate an armor score
function calculateArmorScore(equipment) {
  let score = 0;
  if (!equipment || !Array.isArray(equipment)) return 0;

  // Example scoring - adjust values as needed
  const materialScore = { leather: 1, chainmail: 2, iron: 3, golden: 2, diamond: 4, netherite: 5 };
  const slotMultiplier = { head: 1, torso: 1.6, legs: 1.4, feet: 1, mainhand: 0, offhand: 0 }; // Slot indices 0-3 are armor

  for (let i = 0; i < 4; i++) { // Only check armor slots (head, chest, legs, feet)
    const item = equipment[i];
    if (item) {
      let itemMaterial = null;
      const nameParts = item.name.split('_');
      if (nameParts.length > 1) {
        itemMaterial = nameParts[0];
      }

      const matScore = materialScore[itemMaterial] || 0;
      const slot = Object.keys(slotMultiplier)[i];
      const mult = slotMultiplier[slot] || 1;
      score += matScore * mult;
    }
  }
  return score;
}

// Helper function to calculate score for melee weapons (swords, axes)
function calculateMeleeWeaponScore(item) {
  if (!item) return 0;
  const name = item.name;
  let score = 0;
  // Example scoring - adjust as needed
  const materialScore = { wooden: 1, stone: 2, iron: 3, golden: 2, diamond: 4, netherite: 5 };

  if (name.includes('sword') || name.includes('axe')) {
    const material = name.split('_')[0];
    score = materialScore[material] || 0;
  }
  return score;
}

// Helper function to check if an item is a bow
function isBow(item) {
  return item && item.name.includes('bow');
}


class BotMemory {
  constructor(bot) {
    this.bot = bot;
    // Use the attached manager reference
    // this.botManager = bot.botManager; // Old way
    this.mcData = mcData(bot.version); // Get minecraft-data instance for bot's version
    this.nearbyEntities = {}; // { id: { entity: entityRef, type: 'player'|'mob'|'other', ..., threatLevel: number } }
    this.botDistances = {}; // { botId: distance }
    this.currentActivity = null; // String name of the current activity
    this.targetCoordinates = null; // Vec3 | null - Target for pathfinding or other activities
    this.combatTargetId = null; // String | number | null - Target ID for combat activity
    this.guardTargetId = null; // String | number | null - Target ID for guard activity
    this.updateIntervalId = null;
    this.nearbyRadius = DEFAULT_NEARBY_RADIUS;
    this.strengthLevel = 0; // Bot's own calculated strength
    this.interruptedActivity = null; // Activity interrupted by defense monitor
    this.recentAttackers = {}; // { username: timestamp } - Tracks recent attackers
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
        let threatLevel = 0; // Default threat level

        // Determine threat level
        if (entity.kind === 'Hostile mob') {
          // threatLevel = 2; // REMOVED - Threat level no longer used for hostile mobs
          // Optional: Could increase based on mob equipment later
        } else if (entity.type === 'player') {
          // Check if the player is a managed bot using the attached reference
          const isManaged = this.bot.botManagerRef?.isManagedBot(entity.username); // Use optional chaining on botManagerRef

          if (!isManaged) {
            // Player Threat Calculation - Aligned with Strength Calculation
            const isHoldingWeapon = isWeapon(entity.heldItem);

            if (isHoldingWeapon) {
              // Calculate threat only if holding a weapon
              const armorScore = calculateArmorScore(entity.equipment);
              const heldMeleeScore = calculateMeleeWeaponScore(entity.heldItem);
              const isHoldingBow = isBow(entity.heldItem);
              const weaponScore = heldMeleeScore + (isHoldingBow ? 2 : 0); // Use same bow bonus logic

              // Use same armor scaling as strengthLevel calculation (/ 2)
              let gearThreatLevel = weaponScore + Math.floor(armorScore / 2);

              // Apply persistent threat boost from manager using the attached reference
              const boost = this.bot.botManagerRef?.getPlayerThreatBoost(entity.username) || 0; // Use optional chaining on botManagerRef and default to 0
              threatLevel = gearThreatLevel + boost;

              // Optional: Log if boost is applied
              // if (boost > 0) {
              //   console.log(`[ThreatCalc] Applied boost ${boost} to ${entity.username}. Gear: ${gearThreatLevel}, Final: ${threatLevel}`);
              // }

            } else {
              // Not holding a weapon = no threat, regardless of boost
              threatLevel = 0;
            }
          } else {
            // Managed bots are not threats to each other
            threatLevel = 0;
          }
        } else {
          threatLevel = 0; // Other entities (items, objects, passive mobs) are not threats
        }

        newNearbyEntities[entity.id] = {
          entity: entity, // Keep reference for direct access if needed
          id: entity.id,
          uuid: entity.uuid, // Useful for players
          type: entity.type, // 'player', 'mob', 'object', etc.
          kind: entity.kind, // 'Hostile mob', 'Passive mob', etc.
          name: entity.name, // Mob type or object name
          username: entity.username, // Player username
          position: entity.position.clone(), // Clone to avoid mutation issues
          distance: distance,
          equipment: entity.equipment, // Store equipment array
          heldItem: entity.heldItem, // Store held item
          threatLevel: threatLevel // Store calculated threat level
        };
      }
    }
    this.nearbyEntities = newNearbyEntities;
    // Optional: Log detailed entity info for debugging
    // if (Object.keys(this.nearbyEntities).length > 0) {
    //   console.log(`[BotMemory ${this.bot.username}] Nearby:`, Object.values(this.nearbyEntities).map(e => `${e.username || e.name || e.type}:${e.threatLevel}@${e.distance.toFixed(1)}`).join(', '));
    // }

    // Update the bot's own strength level after updating nearby entities
    this._updateStrengthLevel();

    // Clean up old attackers
    const now = Date.now();
    for (const username in this.recentAttackers) {
      if (now - this.recentAttackers[username] > HOSTILITY_TIMEOUT) {
        delete this.recentAttackers[username];
      }
    }
  }

  /**
   * Internal method to calculate and update the bot's own strength level.
   */
  _updateStrengthLevel() {
    if (!this.bot.inventory || !this.bot.equipment) {
      this.strengthLevel = 0; // Cannot calculate without inventory/equipment
      return;
    }

    const armorScore = calculateArmorScore(this.bot.equipment);
    let bestMeleeScore = 0;
    let hasBow = false;

    // Iterate through inventory to find best melee weapon and check for bow
    for (const item of this.bot.inventory.items()) {
      const meleeScore = calculateMeleeWeaponScore(item);
      bestMeleeScore = Math.max(bestMeleeScore, meleeScore);
      if (isBow(item)) {
        hasBow = true;
      }
    }

    const bowBonus = hasBow ? 2 : 0;
    const totalWeaponScore = bestMeleeScore + bowBonus;
    // Example scaling for armor score - adjust divisor as needed
    this.strengthLevel = totalWeaponScore + Math.floor(armorScore / 2);
    // console.log(`[BotMemory ${this.bot.username}] Strength updated: ${this.strengthLevel} (W: ${totalWeaponScore}, A: ${armorScore.toFixed(1)})`); // Optional debug log
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

  /**
   * Registers that a player has attacked the bot.
   * @param {string} username - The username of the attacking player.
   */
  registerAttack(username) {
    if (!username) return;
    this.recentAttackers[username] = Date.now();
    // console.log(`[BotMemory ${this.bot.username}] Registered attack from ${username}`); // Optional debug log
  }

  /**
   * Checks if a player has attacked the bot recently.
   * @param {string} username - The username of the player to check.
   * @returns {boolean} True if the player attacked within the HOSTILITY_TIMEOUT.
   */
  isRecentlyHostile(username) {
    if (!username || !this.recentAttackers[username]) {
      return false;
    }
    const lastAttackTime = this.recentAttackers[username];
    return (Date.now() - lastAttackTime) <= HOSTILITY_TIMEOUT;
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

  /**
   * Sets the combat target ID in the bot's memory.
   * @param {string | number | null} targetId - The entity ID or username of the target, or null to clear.
   */
  setCombatTargetId(targetId) {
    this.combatTargetId = targetId;
    // console.log(`[BotMemory ${this.bot.username}] Combat target ID set to:`, this.combatTargetId); // Optional: for debugging
  }

  /**
   * Gets the combat target ID from the bot's memory.
   * @returns {string | number | null} The target ID or null if not set.
   */
  getCombatTargetId() {
    return this.combatTargetId;
  }

  /**
   * Sets the guard target ID in the bot's memory.
   * @param {string | number | null} targetId - The entity ID or username of the target, or null to clear.
   */
  setGuardTargetId(targetId) {
    this.guardTargetId = targetId;
    // console.log(`[BotMemory ${this.bot.username}] Guard target ID set to:`, this.guardTargetId); // Optional: for debugging
  }

  /**
   * Gets the guard target ID from the bot's memory.
   * @returns {string | number | null} The target ID or null if not set.
   */
  getGuardTargetId() {
    return this.guardTargetId;
  }

  /**
   * Gets the bot's calculated strength level.
   * @returns {number} The strength level.
   */
  getStrengthLevel() {
    return this.strengthLevel;
  }

  /**
   * Sets the name of the activity that was interrupted by the defense monitor.
   * @param {string | null} activityName - The name of the interrupted activity, or null to clear.
   */
  setInterruptedActivity(activityName) {
    this.interruptedActivity = activityName;
    // console.log(`[BotMemory ${this.bot.username}] Interrupted activity set to: ${activityName}`);
  }

  /**
   * Gets the name of the activity that was interrupted by the defense monitor.
   * @returns {string | null} The name of the interrupted activity, or null if none stored.
   */
  getInterruptedActivity() {
    return this.interruptedActivity;
  }
}

// The main plugin function injected into Mineflayer
function inject(bot) {
  bot.memory = new BotMemory(bot);

  // Listen for attacks on the bot
  bot.on('attack', (attacker, victim, weapon) => {
    // Check if the bot itself was the victim and the attacker is a player
    if (victim === bot.entity && attacker && attacker.type === 'player' && attacker.username) {
      // Check if the attacker is not a managed bot (avoid friendly fire issues)
      const isManaged = bot.botManagerRef?.isManagedBot(attacker.username);
      if (!isManaged) {
        bot.memory.registerAttack(attacker.username);
      }
    }
  });
}

module.exports = inject;
