import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { goals } from '@nxg-org/mineflayer-pathfinder';

const { GoalBlock } = goals;
const logger = createLogger('bot-agent:navigation');

export interface NavigationParams {
  destination: Coordinates;
  tolerance?: number;
}

export class NavigationModule extends BaseModule {
  readonly name = 'navigation';
  private pathfinderInstance: any = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
    // Pathfinder plugin is loaded on the bot — get reference after spawn
  }

  initialize(): void {
    this.pathfinderInstance = (this.bot as any).pathfinder;
    if (this.pathfinderInstance) {
      this.pathfinderInstance.setOptions?.({
        allowSprinting: true,
        canDig: true,
      });
    }
  }

  protected async run(params: NavigationParams, signal: AbortSignal): Promise<void> {
    const { destination, tolerance } = params;
    if (!this.pathfinderInstance) {
      return this.fail('Pathfinder plugin not available');
    }

    logger.info(`Navigating to (${destination.x}, ${destination.y}, ${destination.z})`);

    const success = await this.navigateTo(destination, signal);
    if (signal.aborted) return;

    if (success) {
      this.complete({ arrivedAt: destination });
    } else {
      this.fail('Navigation failed or timed out');
    }
  }

  /** Public navigateTo for use by other modules */
  async navigateTo(coords: Coordinates, signal?: AbortSignal): Promise<boolean> {
    if (!this.pathfinderInstance) return false;

    return new Promise<boolean>((resolve) => {
      const goal = new GoalBlock(coords.x, coords.y, coords.z);
      let settled = false;

      const cleanup = () => {
        this.pathfinderInstance.removeListener('goal_reached', onGoalReached);
        this.pathfinderInstance.removeListener('error', onError);
        clearTimeout(timeout);
      };

      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onGoalReached = () => settle(true);
      const onError = (err: Error) => {
        logger.error('Pathfinder error:', err.message);
        settle(false);
      };

      this.pathfinderInstance.on('goal_reached', onGoalReached);
      this.pathfinderInstance.on('error', onError);

      const timeout = setTimeout(() => {
        logger.warn('Navigation timed out after 60 seconds');
        this.pathfinderInstance.stop?.();
        settle(false);
      }, 60000);

      if (signal) {
        signal.addEventListener('abort', () => {
          this.pathfinderInstance.stop?.();
          settle(false);
        }, { once: true });
      }

      this.pathfinderInstance.setGoal(goal, true);
    });
  }

  protected cleanup(): void {
    this.pathfinderInstance?.stop?.();
  }
}
