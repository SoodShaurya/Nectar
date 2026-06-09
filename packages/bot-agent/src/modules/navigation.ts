import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { GoalNear, GoalXZ } = goals;
const logger = createLogger('bot-agent:navigation');

export interface NavigationParams {
  destination: Coordinates;
  tolerance?: number;
}

export class NavigationModule extends BaseModule {
  readonly name = 'navigation';
  private mcData: any = null;
  private movements: Movements | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(): void {
    this.mcData = require('minecraft-data')(this.bot.version);

    // Canonical mineflayer-pathfinder usage — proven stable on this server by a
    // bare vanilla test. Library DEFAULT movements (canDig, allowParkour,
    // allowSprinting, allow1by1towers all true); the library self-recovers when
    // stuck and self-terminates on NoPath/Timeout.
    if (!(this.bot as any).pathfinder) {
      this.bot.loadPlugin(pathfinder);
    }
    this.movements = new Movements(this.bot);
    (this.bot as any).pathfinder.setMovements(this.movements);
  }

  protected async run(params: NavigationParams, signal: AbortSignal): Promise<void> {
    const { destination, tolerance } = params;
    if (!(this.bot as any).pathfinder) {
      return this.fail('Pathfinder plugin not available');
    }

    logger.info(`Navigating to (${destination.x}, ${destination.y}, ${destination.z})`);

    const success = await this.navigateTo(destination, signal, tolerance);
    if (signal.aborted) return;

    if (success) {
      this.complete({ arrivedAt: destination });
    } else {
      this.fail('Navigation failed or timed out');
    }
  }

  /**
   * Public navigateTo for use by other modules. Use ignoreY for exploration-style goals.
   *
   * Canonical mineflayer-pathfinder: await goto() and trust the library to
   * self-recover from being stuck and self-terminate on NoPath/Timeout. A
   * generous wall-clock backstop (cancelled via setGoal(null)) guards the rare
   * hang. Resolves false instead of throwing.
   */
  async navigateTo(coords: Coordinates, signal?: AbortSignal, tolerance: number = 2, ignoreY: boolean = false, timeoutMs: number = 60000): Promise<boolean> {
    const pf = (this.bot as any).pathfinder;
    if (!pf) return false;

    const pos = this.bot.entity.position;
    if (isNaN(pos.x) || isNaN(pos.y) || isNaN(pos.z)) {
      logger.error('Bot position is NaN, cannot navigate');
      return false;
    }

    const goal = ignoreY
      ? new GoalXZ(coords.x, coords.z)
      : new GoalNear(coords.x, coords.y, coords.z, tolerance);

    const cancel = () => { try { pf.setGoal(null); } catch { /* ignore */ } };
    let backstop: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;

    try {
      const gotoP = pf.goto(goal).then(() => true).catch((err: any) => {
        if (!['GoalChanged', 'PathStopped', 'NoPath', 'Timeout'].includes(err?.name)) {
          logger.warn(`Pathfinder error: [${err?.name}] ${err?.message ?? err}`);
        }
        return false;
      });

      const backstopP = new Promise<boolean>((resolve) => {
        backstop = setTimeout(() => {
          logger.warn(`Navigation backstop hit after ${Math.round(timeoutMs / 1000)}s; cancelling`);
          cancel();
          resolve(false);
        }, timeoutMs);
      });

      const racers: Promise<boolean>[] = [gotoP, backstopP];
      if (signal) {
        if (signal.aborted) { cancel(); return false; }
        racers.push(new Promise<boolean>((resolve) => {
          abortHandler = () => { cancel(); resolve(false); };
          signal.addEventListener('abort', abortHandler, { once: true });
        }));
      }

      return await Promise.race(racers);
    } finally {
      if (backstop) clearTimeout(backstop);
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    }
  }

  /** Is the bot currently submerged / floating in water? */
  private isInWater(): boolean {
    const feet = this.bot.blockAt(this.bot.entity.position);
    const head = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0));
    const wet = (b: any) => b && (b.name === 'water' || b.name === 'seagrass' || b.name === 'tall_seagrass' || b.name === 'kelp' || b.name === 'kelp_plant');
    return wet(feet) || wet(head);
  }

  /** Nearest standable land surface (solid ground with air above), or null. */
  private findNearestLandSurface(maxDistance: number = 64): { x: number; y: number; z: number } | null {
    const groundNames = [
      'grass_block', 'dirt', 'podzol', 'coarse_dirt', 'rooted_dirt', 'sand', 'red_sand',
      'gravel', 'stone', 'snow_block', 'moss_block', 'mud', 'packed_mud', 'clay',
    ];
    const ids = groundNames.map((n) => this.mcData?.blocksByName[n]?.id).filter((x: any) => x !== undefined);
    if (ids.length === 0) return null;
    const positions = this.bot.findBlocks({ matching: ids, maxDistance, count: 128 });
    for (const pos of positions) {
      const above = this.bot.blockAt(pos.offset(0, 1, 0));
      if (above && above.name === 'air') return { x: pos.x, y: pos.y + 1, z: pos.z };
    }
    return null;
  }

  /** Manually swim toward a target while holding jump — reliably hops out of water. */
  private async swimToward(target: { x: number; y: number; z: number }, signal?: AbortSignal, maxMs = 8000): Promise<void> {
    const deadline = Date.now() + maxMs;
    const tgt = new Vec3(target.x + 0.5, target.y, target.z + 0.5);
    try {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('jump', true); // swim up + hop the ledge
      this.bot.setControlState('sprint', true);
      while (Date.now() < deadline && this.isInWater()) {
        if (signal?.aborted) break;
        try { await this.bot.lookAt(tgt, true); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sprint', false);
    }
    if (!this.isInWater()) logger.info('Climbed out of water');
  }

  /**
   * Get the bot onto safe ground after a hostile spawn:
   *  - in WATER  -> swim to the nearest land surface and climb out (the bot
   *                 floats, so mining down here would just stall — and it can drown);
   *  - on a TREE -> mine straight down the trunk (pathfinder won't tunnel down).
   * Returns true once on non-tree solid ground (or already there).
   */
  async recoverToSafeGround(signal?: AbortSignal, maxSteps: number = 48): Promise<boolean> {
    // --- Water: swim out before anything else (avoid getting stuck/killed at the edge) ---
    for (let tries = 0; tries < 4 && this.isInWater(); tries++) {
      if (signal?.aborted) return false;
      const land = this.findNearestLandSurface(64);
      if (!land) { logger.warn('Spawned in water but no land found within 64 blocks'); break; }
      logger.info(`In water — heading to land at (${land.x}, ${land.y}, ${land.z})`);
      await this.navigateTo(land, signal, 1, false, 15000);
      // Pathfinder is unreliable at the water->land climb, so if we're still wet,
      // manually swim toward the shore while holding jump to hop out.
      if (this.isInWater()) await this.swimToward(land, signal);
    }

    // --- Tree canopy: mine straight down to the ground ---
    const isTreeBlock = (name: string) =>
      name.endsWith('_log') || name.endsWith('_leaves') || name.endsWith('_wood') ||
      name.endsWith('_stem') || name.endsWith('_hyphae') || name === 'mangrove_roots';

    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) return false;
      const feet = this.bot.entity.position.floored();
      const below = this.bot.blockAt(feet.offset(0, -1, 0));
      if (!below) return false; // chunk not loaded

      const empty = below.name === 'air' || below.name === 'cave_air' || (below as any).boundingBox === 'empty';
      if (empty) {
        // Mid-fall or a gap — let gravity settle, then re-check.
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (!isTreeBlock(below.name)) {
        if (i > 0) logger.info(`Descended to ground (${below.name}) after ${i} step(s)`);
        return true; // standing on real (non-tree) ground
      }
      // Don't dig into a lava pocket beneath the trunk.
      const twoBelow = this.bot.blockAt(feet.offset(0, -2, 0));
      if (twoBelow && twoBelow.name === 'lava') {
        logger.warn('Descent aborted: lava below trunk');
        return false;
      }
      try {
        await this.bot.dig(below);
      } catch (err) {
        logger.warn('Descent dig failed:', err);
        return false;
      }
      await new Promise((r) => setTimeout(r, 400)); // fall one block
    }
    return false;
  }

  protected cleanup(): void {
    try {
      (this.bot as any).pathfinder?.setGoal?.(null);
    } catch {
      // ignore
    }
  }
}
