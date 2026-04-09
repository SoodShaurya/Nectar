import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';
import { Vec3 } from 'vec3';

const logger = createLogger('bot-agent:storage');

export interface StorageParams {
  action: 'take' | 'deposit' | 'search';
  position?: Coordinates;
  items?: Array<{ item: string; count: number }>;
  searchRadius?: number;
  lookingFor?: string[];
}

export class StorageModule extends BaseModule {
  readonly name = 'storage';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: StorageParams, signal: AbortSignal): Promise<void> {
    const { action } = params;

    switch (action) {
      case 'take':
        await this.takeFromChest(params, signal);
        break;
      case 'deposit':
        await this.depositToChest(params, signal);
        break;
      case 'search':
        await this.searchChests(params, signal);
        break;
      default:
        this.fail(`Unknown storage action: ${action}`);
    }
  }

  private async takeFromChest(params: StorageParams, signal: AbortSignal): Promise<void> {
    if (!params.position || !params.items) {
      return this.fail('Take action requires position and items');
    }

    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(params.position, signal);
      if (this.isAborted(signal)) return;
      if (!reached) return this.fail('Could not reach chest');
    }

    const chestBlock = this.bot.blockAt(new Vec3(params.position.x, params.position.y, params.position.z));
    if (!chestBlock) return this.fail('No block at specified position');

    try {
      const chest = await this.bot.openContainer(chestBlock);
      const taken: Array<{ item: string; count: number }> = [];

      for (const req of params.items) {
        const itemData = this.mcData.itemsByName[req.item];
        if (!itemData) {
          logger.warn(`Unknown item: ${req.item}`);
          continue;
        }

        // Find item in chest
        const chestItems = chest.containerItems().filter((i: any) => i.type === itemData.id);
        let remaining = req.count;

        for (const ci of chestItems) {
          if (remaining <= 0) break;
          const toTake = Math.min(remaining, ci.count);
          await chest.withdraw(ci.type, ci.metadata, toTake);
          remaining -= toTake;
          taken.push({ item: req.item, count: toTake });
        }
      }

      // Log chest contents to world state
      this.logChestContents(chest, params.position);
      chest.close();

      this.complete({ taken });
    } catch (err) {
      this.fail(`Failed to take from chest: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async depositToChest(params: StorageParams, signal: AbortSignal): Promise<void> {
    if (!params.position || !params.items) {
      return this.fail('Deposit action requires position and items');
    }

    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(params.position, signal);
      if (this.isAborted(signal)) return;
      if (!reached) return this.fail('Could not reach chest');
    }

    const chestBlock = this.bot.blockAt(new Vec3(params.position.x, params.position.y, params.position.z));
    if (!chestBlock) return this.fail('No block at specified position');

    try {
      const chest = await this.bot.openContainer(chestBlock);
      const deposited: Array<{ item: string; count: number }> = [];

      for (const req of params.items) {
        const itemData = this.mcData.itemsByName[req.item];
        if (!itemData) continue;

        const invItems = this.bot.inventory.items().filter(i => i.type === itemData.id);
        let remaining = req.count;

        for (const ii of invItems) {
          if (remaining <= 0) break;
          const toDeposit = Math.min(remaining, ii.count);
          await chest.deposit(ii.type, ii.metadata, toDeposit);
          remaining -= toDeposit;
          deposited.push({ item: req.item, count: toDeposit });
        }
      }

      this.logChestContents(chest, params.position);
      chest.close();

      this.complete({ deposited });
    } catch (err) {
      this.fail(`Failed to deposit to chest: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async searchChests(params: StorageParams, signal: AbortSignal): Promise<void> {
    const { searchRadius = 32, lookingFor = [] } = params;

    const chestBlockId = this.mcData.blocksByName['chest']?.id;
    if (!chestBlockId) return this.fail('Chest block not found in game data');

    const chests = this.bot.findBlocks({
      matching: chestBlockId,
      maxDistance: searchRadius,
      count: 20,
    });

    if (chests.length === 0) {
      return this.fail('No chests found in search radius');
    }

    logger.info(`Found ${chests.length} chests to search`);
    const allContents: Array<{ position: Coordinates; items: Array<{ name: string; count: number }> }> = [];
    const foundItems: Array<{ item: string; position: Coordinates }> = [];

    for (const chestPos of chests) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();

      if (this.navigationModule) {
        const reached = await this.navigationModule.navigateTo(
          { x: chestPos.x, y: chestPos.y, z: chestPos.z }, signal
        );
        if (this.isAborted(signal)) return;
        if (!reached) continue;
      }

      const chestBlock = this.bot.blockAt(chestPos);
      if (!chestBlock) continue;

      try {
        const chest = await this.bot.openContainer(chestBlock);
        const items = chest.containerItems().map((i: any) => ({
          name: i.name,
          count: i.count,
        }));

        const pos = { x: chestPos.x, y: chestPos.y, z: chestPos.z };
        allContents.push({ position: pos, items });

        // Check for lookingFor items
        for (const target of lookingFor) {
          if (items.some((i: any) => i.name === target)) {
            foundItems.push({ item: target, position: pos });
          }
        }

        this.logChestContents(chest, pos);
        chest.close();
      } catch (err) {
        logger.warn(`Failed to open chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}):`, err);
      }
    }

    this.complete({
      chestsSearched: allContents.length,
      foundItems,
      allContents,
    });
  }

  private logChestContents(chest: any, position: Coordinates): void {
    const items = chest.containerItems().map((i: any) => ({
      name: i.name,
      count: i.count,
    }));

    this.reportEvent({
      eventType: 'foundPOI',
      details: {
        poiType: 'chest',
        location: position,
        details: { contents: items },
      },
    });
  }
}
