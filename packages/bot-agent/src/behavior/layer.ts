import { EventEmitter } from 'events';
import { Bot } from 'mineflayer';
import { createLogger } from '@aetherius/shared-types';
import { AgentBehaviorProfile, createDefaultProfile } from './profile';
import { BehaviorAlert, BehaviorAlertType } from './alerts';
import { AgentModule } from '../types';
import { Entity } from 'prismarine-entity';

const logger = createLogger('bot-agent:behavior');

const TICK_INTERVAL_MS = 50;

// Mob threat scores for auto engagement
const MOB_THREAT: Record<string, number> = {
  zombie: 2, drowned: 2, husk: 2, zombie_villager: 2,
  skeleton: 3, stray: 3, bogged: 3,
  creeper: 4, witch: 4, blaze: 4, ghast: 4,
  enderman: 5, wither_skeleton: 5, piglin_brute: 6, warden: 10,
  spider: 2, cave_spider: 3, slime: 1, magma_cube: 2,
  phantom: 3, pillager: 3, vindicator: 4, ravager: 6, evoker: 5,
};

const ARMOR_TIER: Record<string, number> = {
  leather: 1, chainmail: 2, iron: 3, diamond: 4, netherite: 5,
};

const WEAPON_TIER: Record<string, number> = {
  wooden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5,
};

export class BehaviorLayer extends EventEmitter {
  private bot: Bot;
  private agentId: string;
  private profile: AgentBehaviorProfile;
  private activeModule: AgentModule | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  // State tracking for hysteresis and cooldowns
  private isRetreating = false;
  private inCombat = false;
  private combatTargetId: number | null = null;
  private lastBasicAttack = 0;
  private lastHealthAlertTime = 0;
  private lastFoodAlertTime = 0;
  private lastPlayerAlertTime = 0;
  private knownPlayerAlerts: Set<string> = new Set(); // Cooldown per player

  constructor(bot: Bot, agentId: string, profile?: AgentBehaviorProfile) {
    super();
    this.bot = bot;
    this.agentId = agentId;
    this.profile = profile ?? createDefaultProfile();
  }

  start(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    logger.info('Behavior layer started');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  setActiveModule(module: AgentModule | null): void {
    this.activeModule = module;
  }

  updateProfile(profile: Partial<AgentBehaviorProfile>): void {
    this.profile = { ...this.profile, ...profile };
    logger.info('Behavior profile updated');
  }

  getProfile(): AgentBehaviorProfile {
    return this.profile;
  }

  private tick(): void {
    if (!this.bot.entity) return; // Bot not spawned yet

    // Priority 1: Survival — health check
    this.checkHealth();

    // Priority 2: Food reserve check (informational)
    this.checkFoodReserve();

    // Priority 3: Hostile scan
    this.checkHostiles();

    // Priority 4: Player scan
    this.checkPlayers();

    // Priority 5: Environment (night)
    this.checkEnvironment();
  }

  // --- Priority 1: Health ---
  private checkHealth(): void {
    const healthPct = this.bot.health / 20;
    const threshold = this.profile.retreatHealthThreshold;

    if (healthPct < threshold && !this.isRetreating) {
      this.isRetreating = true;
      this.activeModule?.pause();

      const alert = this.createAlert('health_low', {
        health: this.bot.health,
        threshold,
        retreatingTo: null, // TODO: determine safe retreat position
      }, this.activeModule ? 'paused' : 'unaffected');

      this.emitAlert(alert);
      logger.warn(`Health low (${(healthPct * 100).toFixed(0)}%), retreating`);
    }

    // Hysteresis: resume when health > threshold + 0.1
    if (this.isRetreating && healthPct > threshold + 0.1) {
      this.isRetreating = false;
      this.activeModule?.resume();
      logger.info('Health recovered, resuming');
    }
  }

  // --- Priority 2: Food Reserve ---
  private checkFoodReserve(): void {
    const now = Date.now();
    if (now - this.lastFoodAlertTime < 30000) return; // 30s cooldown

    const foodCount = this.bot.inventory.items().filter(i => this.isFood(i.name)).reduce((s, i) => s + i.count, 0);
    if (foodCount <= this.profile.foodReserveMinimum) {
      this.lastFoodAlertTime = now;
      this.emitAlert(this.createAlert('food_reserve_low', {
        currentFood: foodCount,
        threshold: this.profile.foodReserveMinimum,
      }, 'unaffected'));
    }
  }

  // --- Priority 3: Hostile Scan ---
  private checkHostiles(): void {
    if (this.isRetreating) return; // health-retreat takes precedence

    const pos = this.bot.entity.position;
    const pvp = (this.bot as any).swordpvp || (this.bot as any).pvp;

    // Find the nearest threatening hostile (incl. creepers — defend against them too).
    const hostile = this.bot.nearestEntity((e) =>
      e.type === 'hostile' && e.position.distanceTo(pos) < this.profile.hostileDetectionRadius,
    );

    // No hostile nearby: if we were fighting, stand down and resume the task.
    if (!hostile) {
      if (this.inCombat) {
        this.inCombat = false;
        this.combatTargetId = null;
        try { pvp?.stop?.(); } catch { /* ignore */ }
        this.activeModule?.resume();
        logger.info('Hostiles cleared — resuming task');
      }
      return;
    }

    // A hostile is in range — DEFEND (the old code only alerted, so the bot just
    // died). Pause the active task and engage. Engage on TARGET CHANGE only so we
    // don't reset the pvp plugin every 50ms tick.
    if (!this.inCombat) {
      this.inCombat = true;
      this.activeModule?.pause();
      logger.info(`Engaging hostile: ${hostile.name} (gear=${this.getGearScore()})`);
    }
    try {
      if (pvp?.attack) {
        if (this.combatTargetId !== hostile.id) {
          this.combatTargetId = hostile.id;
          pvp.attack(hostile); // continuous combat until target dies / stop()
        }
      } else {
        // No pvp plugin: basic attacks on the melee cooldown.
        const now = Date.now();
        if (now - this.lastBasicAttack > 600) {
          this.lastBasicAttack = now;
          try { this.bot.lookAt(hostile.position.offset(0, hostile.height * 0.9, 0), true); } catch { /* ignore */ }
          this.bot.attack(hostile);
        }
      }
    } catch { /* ignore transient combat errors */ }
  }

  // --- Priority 4: Player Scan ---
  private checkPlayers(): void {
    const now = Date.now();
    if (now - this.lastPlayerAlertTime < 5000) return; // 5s cooldown

    const player = this.bot.nearestEntity((e) =>
      e.type === 'player' && e.username !== this.bot.username &&
      e.position.distanceTo(this.bot.entity.position) < this.profile.playerDetectionRadius
    );

    if (!player || !player.username) return;

    // Cooldown per player (don't spam same player detection)
    if (this.knownPlayerAlerts.has(player.username)) return;
    this.knownPlayerAlerts.add(player.username);
    setTimeout(() => this.knownPlayerAlerts.delete(player.username!), 60000);

    this.lastPlayerAlertTime = now;

    const policy = this.profile.playerResponsePolicy;
    let moduleState: 'paused' | 'cancelled' | 'unaffected' = 'unaffected';

    if (policy === 'avoid' || policy === 'hide') {
      this.activeModule?.pause();
      moduleState = 'paused';
    }

    this.emitAlert(this.createAlert('player_detected', {
      playerName: player.username,
      position: {
        x: Math.floor(player.position.x),
        y: Math.floor(player.position.y),
        z: Math.floor(player.position.z),
      },
      distance: player.position.distanceTo(this.bot.entity.position),
      autonomousResponse: policy,
    }, moduleState));
  }

  // --- Priority 5: Environment ---
  private checkEnvironment(): void {
    if (this.profile.allowNightSurface) return;
    if (this.isRetreating) return;

    const timeOfDay = this.bot.time.timeOfDay;
    const isNight = timeOfDay > 13000 && timeOfDay < 23000;

    if (!isNight) return;

    // Check if on surface (sky light > 0)
    const pos = this.bot.entity.position;
    const block = this.bot.blockAt(pos.offset(0, 2, 0));
    const isSurface = block && (block.skyLight ?? 15) > 0;

    if (!isSurface) return;

    // Check dimension — only applies in overworld
    const dimension = (this.bot as any).game?.dimension;
    if (dimension === 'the_nether' || dimension === 'the_end') return;

    this.activeModule?.pause();
    this.emitAlert(this.createAlert('night_shelter', {
      shelterLocation: null,
      estimatedResume: 23000 - timeOfDay, // ticks until sunrise
    }, 'paused'));
  }

  // --- Utility ---
  private getGearScore(): number {
    let score = 0;
    const armorSlots = [5, 6, 7, 8];
    for (const slot of armorSlots) {
      const item = this.bot.inventory.slots[slot];
      if (item) {
        for (const [material, tier] of Object.entries(ARMOR_TIER)) {
          if (item.name.includes(material)) { score += tier; break; }
        }
      }
    }
    const held = this.bot.heldItem;
    if (held) {
      for (const [material, tier] of Object.entries(WEAPON_TIER)) {
        if (held.name.includes(material) && (held.name.includes('sword') || held.name.includes('axe'))) {
          score += tier; break;
        }
      }
    }
    return score;
  }

  private isFood(name: string): boolean {
    return name.includes('cooked') || name.includes('bread') || name.includes('apple') ||
      name.includes('steak') || name.includes('carrot') || name.includes('potato') ||
      name.includes('melon_slice') || name.includes('sweet_berries');
  }

  private createAlert(
    type: BehaviorAlertType,
    details: Record<string, any>,
    moduleState: 'paused' | 'cancelled' | 'unaffected'
  ): BehaviorAlert {
    return {
      agentId: this.agentId,
      type,
      details,
      activeModule: this.activeModule?.name ?? null,
      moduleState,
      timestamp: Date.now(),
    };
  }

  private emitAlert(alert: BehaviorAlert): void {
    this.emit('alert', alert);
  }
}
