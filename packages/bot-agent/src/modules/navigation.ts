import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';

const { GoalNear, GoalXZ } = goals;
const logger = createLogger('bot-agent:navigation');

export interface NavigationParams {
  destination: Coordinates;
  tolerance?: number;
}

export class NavigationModule extends BaseModule {
  readonly name = 'navigation';
  private movements: Movements | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(): void {
    // Load the pathfinder plugin if not already loaded
    if (!(this.bot as any).pathfinder) {
      this.bot.loadPlugin(pathfinder);
    }

    // Create movements with bot's registry
    this.movements = new Movements(this.bot);
    this.movements.canDig = true;
    this.movements.allowSprinting = true;
    this.movements.allow1by1towers = true;
    this.movements.allowParkour = true;
    (this.movements as any).maxDropDown = 4;

    (this.bot as any).pathfinder.setMovements(this.movements);

    // Listen to pathfinder events for diagnostics
    this.bot.on('path_reset' as any, (reason: string) => {
      logger.info(`Path reset: ${reason}`);
    });
    this.bot.on('goal_reached' as any, () => {
      logger.debug('Goal reached');
    });
    this.bot.on('path_stop' as any, () => {
      logger.debug('Path stopped');
    });
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

  /** Public navigateTo for use by other modules. Use ignoreY for exploration-style goals. */
  async navigateTo(coords: Coordinates, signal?: AbortSignal, tolerance: number = 2, ignoreY: boolean = false): Promise<boolean> {
    const pf = (this.bot as any).pathfinder;
    if (!pf) return false;

    // Guard against NaN position
    const pos = this.bot.entity.position;
    if (isNaN(pos.x) || isNaN(pos.y) || isNaN(pos.z)) {
      logger.error('Bot position is NaN, cannot navigate');
      return false;
    }

    const goal = ignoreY
      ? new GoalXZ(coords.x, coords.z)
      : new GoalNear(coords.x, coords.y, coords.z, tolerance);

    try {
      const gotoPromise = pf.goto(goal);

      if (signal) {
        const result = await Promise.race([
          gotoPromise.then(() => true).catch((err: any) => {
            // 'GoalChanged' and 'PathStopped' are expected when we cancel
            if (err?.name === 'GoalChanged' || err?.name === 'PathStopped') return false;
            logger.error('Pathfinder error:', err?.message ?? err);
            return false;
          }),
          new Promise<boolean>((resolve) => {
            signal.addEventListener('abort', () => {
              pf.stop();
              resolve(false);
            }, { once: true });
          }),
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              logger.warn('Navigation timed out after 60 seconds');
              pf.stop();
              resolve(false);
            }, 60000);
          }),
        ]);
        return result;
      }

      // No signal path
      await Promise.race([
        gotoPromise,
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            logger.warn('Navigation timed out after 60 seconds');
            pf.stop();
            reject(new Error('Navigation timed out'));
          }, 60000);
        }),
      ]);
      return true;
    } catch (err: any) {
      if (err?.name === 'GoalChanged' || err?.name === 'PathStopped') return false;
      if (err?.name === 'NoPath') {
        logger.warn('No path found to target');
        return false;
      }
      if (err?.name === 'Timeout') {
        logger.warn('Pathfinder A* timed out');
        return false;
      }
      logger.error(`Pathfinder error: [${err?.name}] ${err?.message ?? err}`);
      return false;
    }
  }

  protected cleanup(): void {
    try {
      (this.bot as any).pathfinder?.stop?.();
    } catch {
      // ignore
    }
  }
}
