import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';
import { Entity } from 'prismarine-entity';

const logger = createLogger('bot-agent:combat');

export interface CombatParams {
  mode: 'defensive' | 'aggressive' | 'escort' | 'patrol';
  engagementPolicy: 'engage' | 'avoid' | 'auto';
  targetPriority: ('hostile' | 'player' | 'specific')[];
  specificTargets?: string[];
  groupUp?: {
    enabled: boolean;
    rallyPoint?: Coordinates;
    rallyAgent?: string;
    minAgents?: number;
  };
  retreatThreshold: number;
  reportPlayers: boolean;
  patrolArea?: { center: Coordinates; radius: number };
}

// Threat scores for auto engagement policy
const MOB_THREAT_SCORES: Record<string, number> = {
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

const PATROL_PAUSE_MS = 4000; // 4 seconds at each waypoint for chunk loading + scan

export class CombatModule extends BaseModule {
  readonly name = 'combat';
  private navigationModule: NavigationModule | null = null;
  private lastRetreatAt = 0;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.navigationModule = navModule;
  }

  protected async run(params: CombatParams, signal: AbortSignal): Promise<void> {
    const { mode } = params;

    logger.info(`Combat module activated: mode=${mode}, policy=${params.engagementPolicy}`);

    if (mode === 'patrol') {
      return this.runPatrol(params, signal);
    }

    return this.runCombat(params, signal);
  }

  // ===== Standard Combat Loop (defensive/aggressive/escort) =====

  private async runCombat(params: CombatParams, signal: AbortSignal): Promise<void> {
    const { mode, engagementPolicy, targetPriority, specificTargets, retreatThreshold, reportPlayers, groupUp } = params;

    while (!this.isAborted(signal)) {
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      // Check health threshold
      if (this.checkHealthRetreat(retreatThreshold)) return;

      // Find targets based on priority
      const target = this.findTargetByPriority(targetPriority, engagementPolicy, reportPlayers, specificTargets);

      if (!target) {
        if (mode === 'defensive' || mode === 'escort') {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        return this.complete({ reason: 'No targets found' });
      }

      // Auto policy check — avoid if outmatched
      if (engagementPolicy === 'auto' && !this.shouldEngage(target)) {
        logger.info(`Auto policy: avoiding ${target.name} (gear score too low)`);
        if (this.navigationModule) {
          const awayDir = this.bot.entity.position.minus(target.position).normalize().scale(16);
          const awayPos = this.bot.entity.position.plus(awayDir);
          await this.navigationModule.navigateTo(
            { x: Math.floor(awayPos.x), y: Math.floor(awayPos.y), z: Math.floor(awayPos.z) },
            signal
          );
        }
        continue;
      }

      // GroupUp check
      if (groupUp?.enabled && groupUp.minAgents && groupUp.minAgents > 1) {
        this.alert({
          type: 'rally_request',
          rallyPoint: groupUp.rallyPoint ?? {
            x: Math.floor(this.bot.entity.position.x),
            y: Math.floor(this.bot.entity.position.y),
            z: Math.floor(this.bot.entity.position.z),
          },
          minAgents: groupUp.minAgents,
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Engage target
      await this.engageTarget(target);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  // ===== Patrol Mode =====

  private async runPatrol(params: CombatParams, signal: AbortSignal): Promise<void> {
    const { patrolArea, engagementPolicy, targetPriority, retreatThreshold, reportPlayers, specificTargets } = params;

    if (!patrolArea) {
      return this.fail('Patrol mode requires patrolArea parameter');
    }
    if (!this.navigationModule) {
      return this.fail('Patrol mode requires navigation module');
    }

    const sensorRange = this.getSensorRange();
    const waypoints = this.generatePatrolWaypoints(patrolArea.center, patrolArea.radius, sensorRange);

    if (waypoints.length === 0) {
      return this.fail('Could not generate patrol waypoints');
    }

    logger.info(`Patrol started: ${waypoints.length} waypoints, ${patrolArea.radius}-block radius, ${sensorRange}-block sensor range`);

    // If entire area is within sensor range from center, just hold position
    if (waypoints.length === 1) {
      logger.info('Patrol area within sensor range — holding center position');
      await this.navigationModule.navigateTo(waypoints[0], signal);
      if (this.isAborted(signal)) return;

      // Hold and scan indefinitely
      while (!this.isAborted(signal)) {
        await this.waitWhilePaused();
        if (this.isAborted(signal)) return;
        if (this.checkHealthRetreat(retreatThreshold)) return;

        // Engage any targets found by continuous behavior layer scanning
        const target = this.findTargetByPriority(targetPriority, engagementPolicy, reportPlayers, specificTargets);
        if (target && (engagementPolicy !== 'auto' || this.shouldEngage(target))) {
          await this.engageTarget(target);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return;
    }

    // Circuit loop through waypoints
    let waypointIndex = 0;
    while (!this.isAborted(signal)) {
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;
      if (this.checkHealthRetreat(retreatThreshold)) return;

      const wp = waypoints[waypointIndex % waypoints.length];
      logger.debug(`Patrol: moving to waypoint ${waypointIndex % waypoints.length + 1}/${waypoints.length}`);

      // Navigate to waypoint
      const reached = await this.navigationModule!.navigateTo(wp, signal);
      if (this.isAborted(signal)) return;

      if (!reached) {
        // Skip unreachable waypoint
        waypointIndex++;
        continue;
      }

      // Pause at waypoint for chunk loading + entity scanning
      const pauseEnd = Date.now() + PATROL_PAUSE_MS;
      while (Date.now() < pauseEnd && !this.isAborted(signal)) {
        await this.waitWhilePaused();
        if (this.isAborted(signal)) return;

        // Check for hostiles during pause
        const target = this.findTargetByPriority(targetPriority, engagementPolicy, reportPlayers, specificTargets);
        if (target && (engagementPolicy !== 'auto' || this.shouldEngage(target))) {
          logger.info(`Patrol: engaging ${target.name} at waypoint`);
          await this.engageTarget(target);
          // After combat, re-check for more threats
          continue;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
      }

      waypointIndex++;

      // Log circuit completion
      if (waypointIndex % waypoints.length === 0 && waypointIndex > 0) {
        logger.info(`Patrol: completed circuit #${Math.floor(waypointIndex / waypoints.length)}`);
      }
    }
  }

  /**
   * Generate patrol waypoints as a grid covering the patrol area.
   * Spacing is based on sensor range with 20% overlap for coverage guarantees.
   * Returns waypoints in serpentine traversal order.
   */
  private generatePatrolWaypoints(center: Coordinates, radius: number, sensorRange: number): Coordinates[] {
    // If the entire patrol area fits within sensor range, just use center
    if (radius <= sensorRange / 2) {
      return [{ x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }];
    }

    // Spacing: sensor range diameter with 20% overlap
    const spacing = Math.max(8, Math.floor(sensorRange * 0.8));
    const points: Coordinates[] = [];

    // Generate grid points within the circle
    const gridMin = -Math.ceil(radius / spacing);
    const gridMax = Math.ceil(radius / spacing);

    for (let gx = gridMin; gx <= gridMax; gx++) {
      // Collect points for this row
      const row: Coordinates[] = [];
      for (let gz = gridMin; gz <= gridMax; gz++) {
        const x = center.x + gx * spacing;
        const z = center.z + gz * spacing;
        const dist = Math.sqrt((x - center.x) ** 2 + (z - center.z) ** 2);
        if (dist <= radius) {
          row.push({ x: Math.floor(x), y: Math.floor(center.y), z: Math.floor(z) });
        }
      }
      // Serpentine: reverse every other row for efficient traversal
      if (gx % 2 !== 0) row.reverse();
      points.push(...row);
    }

    if (points.length === 0) {
      points.push({ x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) });
    }

    return points;
  }

  /** Get effective sensor range in blocks from server view distance. */
  private getSensorRange(): number {
    try {
      const viewDistance = (this.bot as any).settings?.viewDistance ?? 8;
      return viewDistance * 16; // Chunks to blocks
    } catch {
      return 128; // Fallback: 8 chunks
    }
  }

  // ===== Shared Helpers =====

  private checkHealthRetreat(retreatThreshold: number): boolean {
    const healthPct = this.bot.health / 20;
    if (healthPct <= retreatThreshold) {
      logger.warn(`Health below retreat threshold (${(healthPct * 100).toFixed(0)}%)`);
      this.alert({ type: 'health_low', health: this.bot.health, threshold: retreatThreshold });
      // Actually disengage: break melee and physically flee, not just alert+fail
      // (the old code left the body standing in the mob's hit arc). Gated so a
      // tight caller loop doesn't re-issue the flee path every tick.
      this.retreatFromHostiles();
      this.fail('Health below retreat threshold');
      return true;
    }
    return false;
  }

  /**
   * Break out of melee and move ~10 blocks away from the nearest hostile.
   * Fire-and-forget (callers are sync); gated to avoid path thrashing.
   */
  private retreatFromHostiles(): void {
    const now = Date.now();
    if (now - this.lastRetreatAt < 3000) return; // gate: don't re-issue every tick
    this.lastRetreatAt = now;

    // (a) Break melee so swordpvp stops chasing the target.
    try { (this.bot as any).swordpvp?.stop(); } catch { /* ignore */ }

    // (b) Physically move away from the nearest hostile, ~10 blocks out.
    if (!this.navigationModule || !this.bot.entity) return;
    const hostile = this.bot.nearestEntity((e) =>
      e.type === 'hostile' && e.position.distanceTo(this.bot.entity.position) < 32
    );
    if (!hostile) return;
    try {
      const awayDir = this.bot.entity.position.minus(hostile.position).normalize().scale(10);
      const awayPos = this.bot.entity.position.plus(awayDir);
      // Fire-and-forget: caller is synchronous and about to fail() the module.
      void this.navigationModule.navigateTo(
        { x: Math.floor(awayPos.x), y: Math.floor(awayPos.y), z: Math.floor(awayPos.z) },
      ).catch(() => { /* ignore: best-effort flee */ });
    } catch { /* ignore */ }
  }

  private findTargetByPriority(
    targetPriority: CombatParams['targetPriority'],
    engagementPolicy: string,
    reportPlayers: boolean,
    specificTargets?: string[],
  ): Entity | null {
    for (const priority of targetPriority) {
      let target: Entity | null = null;
      if (priority === 'specific' && specificTargets) {
        target = this.findSpecificTarget(specificTargets);
      } else if (priority === 'hostile') {
        target = this.findHostileTarget(engagementPolicy);
      } else if (priority === 'player') {
        target = this.findPlayerTarget(reportPlayers);
      }
      if (target) return target;
    }
    return null;
  }

  private async engageTarget(target: Entity): Promise<void> {
    // Equip a shield to the off-hand so swordpvp's built-in shield-blocking works.
    await this.equipShield();
    try {
      const pvp = (this.bot as any).swordpvp || (this.bot as any).pvp;
      if (pvp) {
        await pvp.attack(target);
      } else {
        this.bot.attack(target);
      }
    } catch (err) {
      logger.warn('Attack failed:', err);
    }
  }

  /**
   * Equip a shield to the off-hand if we have one and it isn't already equipped.
   * Guarded so we don't re-equip (and interrupt blocking) every engage call.
   */
  private async equipShield(): Promise<void> {
    try {
      // Off-hand is the slot just after the hotbar (slot 45 on the player window).
      const offHandItem = (this.bot.inventory as any).slots?.[45];
      if (offHandItem && offHandItem.name === 'shield') return; // already equipped
      const shield = this.bot.inventory.items().find((i) => i.name === 'shield');
      if (!shield) return;
      await this.bot.equip(shield, 'off-hand');
    } catch (err) {
      logger.warn('Could not equip shield:', err);
    }
  }

  /** Calculate agent gear score */
  getGearScore(): number {
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
    const foodCount = this.bot.inventory.items().filter(i =>
      i.name.includes('cooked') || i.name.includes('bread') || i.name.includes('apple') || i.name.includes('steak')
    ).reduce((sum, i) => sum + i.count, 0);
    if (foodCount >= 10) score += 2;
    else if (foodCount >= 3) score += 1;
    return score;
  }

  private shouldEngage(entity: Entity): boolean {
    const gearScore = this.getGearScore();
    const threatScore = MOB_THREAT_SCORES[entity.name ?? ''] ?? 3;
    return gearScore > threatScore;
  }

  private findHostileTarget(policy: string): Entity | null {
    return this.bot.nearestEntity((e) =>
      e.type === 'hostile' && e.position.distanceTo(this.bot.entity.position) < 16
    );
  }

  private findPlayerTarget(report: boolean): Entity | null {
    const player = this.bot.nearestEntity((e) =>
      e.type === 'player' && e.username !== this.bot.username &&
      e.position.distanceTo(this.bot.entity.position) < 32
    );
    if (player && report) {
      this.alert({
        type: 'player_detected',
        playerName: player.username ?? 'unknown',
        position: { x: player.position.x, y: player.position.y, z: player.position.z },
        distance: player.position.distanceTo(this.bot.entity.position),
      });
    }
    return player;
  }

  private findSpecificTarget(names: string[]): Entity | null {
    return this.bot.nearestEntity((e) =>
      names.includes(e.name ?? '') || names.includes(e.username ?? '')
    );
  }
}
