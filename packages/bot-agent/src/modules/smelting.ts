import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';

const logger = createLogger('bot-agent:smelting');

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

  /** Items smelted per unit of a given fuel. */
  private burnPerFuel(fuel: string): number {
    const table: Record<string, number> = {
      coal: 8, charcoal: 8, coal_block: 80, lava_bucket: 100,
      blaze_rod: 12, dried_kelp_block: 20, bamboo: 0.25, stick: 0.5,
    };
    if (table[fuel] !== undefined) return table[fuel];
    if (/_planks$|_log$|_wood$|_stem$|_hyphae$/.test(fuel)) return 1.5;
    if (/_slab$/.test(fuel)) return 0.75;
    return 1; // unknown fuel — conservative (may over-fuel slightly)
  }

  protected async run(params: SmeltingParams, signal: AbortSignal): Promise<void> {
    const { input, fuel, quantity } = params;
    logger.info(`Smelting ${quantity}x ${input} with ${fuel}`);

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

    const fuelNeeded = Math.max(1, Math.ceil(quantity / this.burnPerFuel(fuel)));
    const fuelCount = this.bot.inventory.count(fuelItem.id, null);
    if (fuelCount < fuelNeeded) {
      return this.fail('Insufficient fuel', {
        missing: [{ item: fuel, need: fuelNeeded, have: fuelCount }],
      });
    }

    // Find or place a furnace.
    const furnaceIds = [
      this.mcData.blocksByName['furnace']?.id,
      this.mcData.blocksByName['blast_furnace']?.id,
    ].filter(Boolean) as number[];

    let furnace = this.bot.findBlock({ matching: furnaceIds, maxDistance: 32 });
    if (!furnace) {
      const furnaceItem = this.bot.inventory.findInventoryItem(
        this.mcData.itemsByName['furnace']?.id, null, false,
      );
      if (!furnaceItem) return this.fail('No furnace found nearby and none in inventory');
      const refBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (refBlock) {
        try {
          await this.bot.equip(furnaceItem, 'hand');
          await this.bot.placeBlock(refBlock, { x: 1, y: 0, z: 0 } as any);
        } catch (err) {
          return this.fail(`Failed to place furnace: ${err}`);
        }
      }
      furnace = this.bot.findBlock({ matching: furnaceIds, maxDistance: 8 });
    }
    if (!furnace) return this.fail('Could not locate furnace');

    // Navigate to the furnace.
    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(
        { x: furnace.position.x, y: furnace.position.y, z: furnace.position.z }, signal,
      );
      if (this.isAborted(signal)) return;
      if (!reached) return this.fail('Could not reach furnace');
    }

    // Smelt, polling the REAL furnace state instead of a fixed timer.
    let collected = 0;
    let lastOutputName: string | undefined;
    let furnaceWindow: any = null;
    try {
      furnaceWindow = await this.bot.openFurnace(furnace);
      await furnaceWindow.putInput(inputItem.id, null, quantity);
      await furnaceWindow.putFuel(fuelItem.id, null, fuelNeeded);

      // Generous safety ceiling; we exit early as soon as smelting is done.
      const deadline = Date.now() + quantity * 12000 + 20000;
      while (collected < quantity && Date.now() < deadline) {
        if (this.isAborted(signal)) break;
        await this.waitForFurnaceTick(furnaceWindow, 1500);

        const out = furnaceWindow.outputItem();
        if (out && out.count > 0) {
          const taken = await furnaceWindow.takeOutput();
          if (taken) {
            collected += taken.count;
            lastOutputName = taken.name;
            logger.info(`Collected ${collected}/${quantity} smelted (${taken.name})`);
          }
        }
        // Nothing left cooking and nothing waiting in output -> finished.
        if (!furnaceWindow.inputItem() && !furnaceWindow.outputItem()) break;
      }
    } catch (err) {
      try { furnaceWindow?.close(); } catch { /* ignore */ }
      return this.fail(`Smelting failed: ${err instanceof Error ? err.message : err}`);
    }
    try { furnaceWindow?.close(); } catch { /* ignore */ }

    if (this.isAborted(signal)) return;
    if (collected <= 0) return this.fail('Smelting produced no output', { input, fuel });
    logger.info(`Smelting complete: ${collected}x ${lastOutputName ?? 'output'}`);
    this.complete({ output: lastOutputName, quantity: collected });
  }

  /** Resolve on the next furnace 'update' event, or after `ms` as a fallback. */
  private waitForFurnaceTick(furnace: any, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { furnace.removeListener('update', finish); } catch { /* ignore */ }
        resolve();
      };
      const timer = setTimeout(finish, ms);
      try { furnace.on('update', finish); } catch { /* ignore */ }
    });
  }
}
