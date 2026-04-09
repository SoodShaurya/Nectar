import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';

const logger = createLogger('bot-agent:smelting');

const SMELT_TICKS_PER_ITEM = 200; // 10 seconds per item
const SMELT_MS_PER_ITEM = SMELT_TICKS_PER_ITEM * 50;

export interface SmeltingParams {
  input: string;
  fuel: string;
  quantity: number;
}

export class SmeltingModule extends BaseModule {
  readonly name = 'smelting';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: SmeltingParams, signal: AbortSignal): Promise<void> {
    const { input, fuel, quantity } = params;
    logger.info(`Smelting ${quantity}x ${input} with ${fuel}`);

    // Check inventory for input and fuel
    const inputItem = this.mcData.itemsByName[input];
    const fuelItem = this.mcData.itemsByName[fuel];
    if (!inputItem) return this.fail(`Unknown input item: ${input}`);
    if (!fuelItem) return this.fail(`Unknown fuel item: ${fuel}`);

    const inputCount = this.bot.inventory.count(inputItem.id, null);
    if (inputCount < quantity) {
      return this.fail('Insufficient input items', {
        missing: [{ item: input, need: quantity, have: inputCount }],
      });
    }

    const fuelCount = this.bot.inventory.count(fuelItem.id, null);
    const fuelNeeded = Math.ceil(quantity / 8); // Each coal smelts 8 items
    if (fuelCount < fuelNeeded) {
      return this.fail('Insufficient fuel', {
        missing: [{ item: fuel, need: fuelNeeded, have: fuelCount }],
      });
    }

    // Find or place furnace
    const furnaceBlock = this.bot.findBlock({
      matching: [
        this.mcData.blocksByName['furnace']?.id,
        this.mcData.blocksByName['blast_furnace']?.id,
      ].filter(Boolean) as number[],
      maxDistance: 32,
    });

    if (!furnaceBlock) {
      // Try placing from inventory
      const furnaceItem = this.bot.inventory.findInventoryItem(
        this.mcData.itemsByName['furnace']?.id, null, false
      );
      if (!furnaceItem) {
        return this.fail('No furnace found nearby and none in inventory');
      }

      const refBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (refBlock) {
        try {
          await this.bot.equip(furnaceItem, 'hand');
          await this.bot.placeBlock(refBlock, { x: 1, y: 0, z: 0 } as any);
        } catch (err) {
          return this.fail(`Failed to place furnace: ${err}`);
        }
      }
    }

    // Re-find furnace after potential placement
    const furnace = this.bot.findBlock({
      matching: [
        this.mcData.blocksByName['furnace']?.id,
        this.mcData.blocksByName['blast_furnace']?.id,
      ].filter(Boolean) as number[],
      maxDistance: 8,
    });

    if (!furnace) return this.fail('Could not locate furnace');

    // Navigate to furnace
    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(
        { x: furnace.position.x, y: furnace.position.y, z: furnace.position.z },
        signal
      );
      if (this.isAborted(signal)) return;
      if (!reached) return this.fail('Could not reach furnace');
    }

    // Open furnace
    try {
      const furnaceWindow = await this.bot.openFurnace(furnace);

      // Put input items
      await furnaceWindow.putInput(inputItem.id, null, quantity);
      // Put fuel
      await furnaceWindow.putFuel(fuelItem.id, null, fuelNeeded);

      // Wait for smelting to complete
      const totalTime = SMELT_MS_PER_ITEM * quantity;
      logger.info(`Waiting ${totalTime / 1000}s for smelting to complete`);

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, totalTime + 2000); // Extra 2s buffer
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });

      if (this.isAborted(signal)) {
        furnaceWindow.close();
        return;
      }

      // Take output
      const output = await furnaceWindow.takeOutput();
      furnaceWindow.close();

      logger.info(`Smelting complete: ${output?.count ?? 0} items`);
      this.complete({ output: output?.name, quantity: output?.count ?? 0 });
    } catch (err) {
      this.fail(`Smelting failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
