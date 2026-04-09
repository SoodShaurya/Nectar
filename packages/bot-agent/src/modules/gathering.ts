import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';

const logger = createLogger('bot-agent:gathering');

export interface GatheringParams {
  targetType: 'block' | 'entity' | 'fishing';
  target: string;       // block name (e.g., "iron_ore") or entity type (e.g., "cow")
  quantity: number;
  maxY?: number;
  searchRadius?: number;
}

export class GatheringModule extends BaseModule {
  readonly name = 'gathering';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: GatheringParams, signal: AbortSignal): Promise<void> {
    const { targetType, target, quantity, maxY, searchRadius = 64 } = params;

    if (targetType === 'fishing') {
      await this.gatherByFishing(quantity, signal);
    } else if (targetType === 'entity') {
      await this.gatherFromEntities(target, quantity, signal);
    } else {
      await this.gatherBlocks(target, quantity, maxY, searchRadius, signal);
    }
  }

  private async gatherBlocks(
    blockName: string, quantity: number, maxY: number | undefined,
    searchRadius: number, signal: AbortSignal
  ): Promise<void> {
    const blockData = this.mcData.blocksByName[blockName];
    if (!blockData) {
      return this.fail(`Unknown block type: ${blockName}`);
    }

    let gathered = 0;
    logger.info(`Gathering ${quantity}x ${blockName}`);

    while (gathered < quantity) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      // Find nearest matching block
      const block = this.bot.findBlock({
        matching: blockData.id,
        maxDistance: searchRadius,
        count: 1,
      });

      if (!block) {
        if (gathered > 0) {
          return this.complete({ gathered, target: blockName });
        }
        return this.fail(`No ${blockName} found within ${searchRadius} blocks`, { gathered });
      }

      // Check Y constraint
      if (maxY !== undefined && block.position.y > maxY) {
        return this.fail(`No ${blockName} found below Y=${maxY}`, { gathered });
      }

      // Navigate to block
      if (!this.navigationModule) {
        return this.fail('Navigation module not available');
      }
      const reached = await this.navigationModule.navigateTo(
        { x: block.position.x, y: block.position.y, z: block.position.z },
        signal
      );
      if (this.isAborted(signal)) return;
      if (!reached) {
        return this.fail(`Could not navigate to ${blockName}`, { gathered });
      }

      // Equip best tool via mineflayer-tool plugin
      try {
        const toolPlugin = (this.bot as any).tool;
        if (toolPlugin) {
          await toolPlugin.equipForBlock(block);
        }
      } catch (err) {
        logger.warn('Failed to equip best tool, using current:', err);
      }

      // Dig the block
      try {
        await this.bot.dig(block);
        gathered++;
        logger.info(`Gathered ${gathered}/${quantity} ${blockName}`);
      } catch (err) {
        logger.error(`Failed to dig ${blockName}:`, err);
        return this.fail(`Dig failed: ${err instanceof Error ? err.message : err}`, { gathered });
      }

      // Check inventory full
      if (this.bot.inventory.emptySlotCount() === 0) {
        this.alert({ type: 'inventory_full', gathered });
        return this.fail('Inventory full', { gathered });
      }
    }

    this.complete({ gathered, target: blockName });
  }

  private async gatherFromEntities(
    entityType: string, quantity: number, signal: AbortSignal
  ): Promise<void> {
    let gathered = 0;
    logger.info(`Gathering ${quantity}x drops from ${entityType}`);

    while (gathered < quantity) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      // Find nearest matching entity
      const entity = this.bot.nearestEntity((e) => {
        return e.name === entityType && e.type === 'mob';
      });

      if (!entity) {
        if (gathered > 0) {
          return this.complete({ gathered, target: entityType });
        }
        return this.fail(`No ${entityType} found nearby`, { gathered });
      }

      // Navigate to entity
      if (!this.navigationModule) {
        return this.fail('Navigation module not available');
      }
      const reached = await this.navigationModule.navigateTo(
        { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        signal
      );
      if (this.isAborted(signal)) return;
      if (!reached) continue; // Entity may have moved, try again

      // Attack entity using pvp plugin
      try {
        const pvp = (this.bot as any).swordpvp || (this.bot as any).pvp;
        if (pvp) {
          await pvp.attack(entity);
        } else {
          // Fallback: basic attack
          this.bot.attack(entity);
        }
        // Wait for entity to die and drops to appear
        await new Promise(resolve => setTimeout(resolve, 2000));
        gathered++;
        logger.info(`Gathered ${gathered}/${quantity} from ${entityType}`);
      } catch (err) {
        logger.warn(`Failed to attack ${entityType}:`, err);
        continue;
      }
    }

    this.complete({ gathered, target: entityType });
  }

  private async gatherByFishing(quantity: number, signal: AbortSignal): Promise<void> {
    let caught = 0;
    logger.info(`Fishing for ${quantity} catches`);

    // Find water
    const waterBlockData = this.mcData.blocksByName['water'];
    if (!waterBlockData) {
      return this.fail('Cannot find water block data');
    }

    const water = this.bot.findBlock({
      matching: waterBlockData.id,
      maxDistance: 32,
      count: 1,
    });

    if (!water) {
      return this.fail('No water found within 32 blocks');
    }

    // Navigate to water edge (one block above water surface)
    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(
        { x: water.position.x, y: water.position.y + 1, z: water.position.z },
        signal
      );
      if (this.isAborted(signal)) return;
      if (!reached) {
        return this.fail('Could not reach water');
      }
    }

    // Equip fishing rod
    const rod = this.bot.inventory.items().find(i => i.name === 'fishing_rod');
    if (!rod) {
      return this.fail('No fishing rod in inventory');
    }

    try {
      await this.bot.equip(rod, 'hand');
    } catch (err) {
      return this.fail(`Failed to equip fishing rod: ${err}`);
    }

    // Fish loop
    while (caught < quantity) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      try {
        await this.bot.fish();
        caught++;
        logger.info(`Caught ${caught}/${quantity}`);
      } catch (err) {
        logger.warn('Fishing attempt failed:', err);
        // Brief delay and retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Check inventory full
      if (this.bot.inventory.emptySlotCount() === 0) {
        this.alert({ type: 'inventory_full', caught });
        return this.fail('Inventory full', { caught });
      }
    }

    this.complete({ caught, target: 'fish' });
  }
}
