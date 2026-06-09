import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';

const logger = createLogger('bot-agent:crafting');

export interface CraftingParams {
  item: string;
  quantity: number;
}

export class CraftingModule extends BaseModule {
  readonly name = 'crafting';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: CraftingParams, signal: AbortSignal): Promise<void> {
    const { item, quantity = 1 } = params;

    const itemData = this.mcData.itemsByName[item];
    if (!itemData) return this.fail(`Unknown item: ${item}`);

    const before = this.countByName(item);

    // 1. Recipes craftable right now WITHOUT a table (2x2 grid). recipesFor only
    //    returns recipes whose ingredients we currently have.
    let recipe = this.firstRecipe(itemData.id, null);
    let table: any = null;

    // 2. None? Then it likely needs a crafting table (3x3). Acquire one and
    //    query table recipes. THIS is the case the old code never handled.
    if (!recipe) {
      table = await this.ensureCraftingTable(signal);
      if (this.isAborted(signal)) return;
      if (table) recipe = this.firstRecipe(itemData.id, table);
    }

    if (!recipe) {
      const missing = this.diagnoseMissing(itemData.id, table);
      return this.fail(
        missing.length ? 'Missing ingredients' : `No recipe found for ${item}`,
        { missing },
      );
    }

    // 3-4. quantity is OUTPUT items; bot.craft takes a number of craft OPERATIONS.
    // Loop toward the target — mineflayer's inventory crafting occasionally
    // under-produces a batch — and stop if a round makes no progress.
    const yieldPer = recipe.result?.count ?? 1;
    let made = this.countByName(item) - before; // 0 at this point, but explicit
    let guard = 0;
    while (made < quantity && guard < 10) {
      guard++;
      if (this.isAborted(signal)) return;
      const affordable = this.affordableOps(recipe);
      if (affordable < 1) break;
      const opsThisRound = Math.min(Math.ceil((quantity - made) / yieldPer), affordable);
      const roundBefore = this.countByName(item);
      try {
        await this.bot.craft(recipe, opsThisRound, table ?? undefined);
      } catch (err) {
        if (made > 0) break; // keep what we already made
        return this.fail(`Crafting failed: ${err instanceof Error ? err.message : err}`);
      }
      const got = this.countByName(item) - roundBefore;
      made += Math.max(0, got);
      if (got <= 0) break; // no progress — avoid spinning
    }

    if (made <= 0) {
      if (this.affordableOps(recipe) < 1) {
        return this.fail('Missing ingredients', { missing: this.diagnoseMissing(itemData.id, table) });
      }
      return this.fail('Craft reported done but inventory did not increase', { item });
    }
    logger.info(`Crafted ${made}x ${item} (target ${quantity}, ${yieldPer}/op)`);
    this.complete({ item, requested: quantity, crafted: made });
  }

  // --- Helpers ---

  private countByName(name: string): number {
    return this.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
  }

  /** First recipe currently craftable for `id` given inventory and (optional) table. */
  private firstRecipe(id: number, table: any): any {
    const recipes = this.bot.recipesFor(id, null, 1, table);
    return recipes && recipes.length > 0 ? recipes[0] : null;
  }

  /** Max number of craft operations the current inventory can afford for `recipe`. */
  private affordableOps(recipe: any): number {
    if (!recipe?.delta) return 1;
    let ops = Infinity;
    for (const d of recipe.delta) {
      if (d.count < 0) {
        const perOp = Math.abs(d.count);
        const have = this.bot.inventory.count(d.id, null);
        ops = Math.min(ops, Math.floor(have / perOp));
      }
    }
    return Number.isFinite(ops) ? ops : 1;
  }

  /**
   * Ingredient shortfall, using the recipe variant we're CLOSEST to affording
   * (e.g. report spruce_planks if we hold spruce, not some other wood).
   */
  private diagnoseMissing(id: number, table: any): Array<{ item: string; need: number; have: number }> {
    const all = this.bot.recipesAll(id, null, table);
    if (!all || all.length === 0) return [];

    let best: any = null;
    let bestShortfall = Infinity;
    for (const r of all) {
      if (!r.delta) continue;
      let shortfall = 0;
      for (const d of r.delta) {
        if (d.count < 0) shortfall += Math.max(0, Math.abs(d.count) - this.bot.inventory.count(d.id, null));
      }
      if (shortfall < bestShortfall) { bestShortfall = shortfall; best = r; }
    }
    if (!best?.delta) return [];

    const missing: Array<{ item: string; need: number; have: number }> = [];
    for (const d of best.delta) {
      if (d.count < 0) {
        const need = Math.abs(d.count);
        const have = this.bot.inventory.count(d.id, null);
        if (have < need) missing.push({ item: this.mcData.items[d.id]?.name ?? `id:${d.id}`, need, have });
      }
    }
    return missing;
  }

  /** Find a nearby crafting table (and navigate to it), or place one from inventory. */
  private async ensureCraftingTable(signal: AbortSignal): Promise<any> {
    const tableId = this.mcData.blocksByName['crafting_table']?.id;
    if (tableId === undefined) return null;

    let table = this.bot.findBlock({ matching: tableId, maxDistance: 32 });

    if (!table) {
      // Place one from inventory next to us.
      const tableItem = this.bot.inventory.items().find((i) => i.name === 'crafting_table');
      if (!tableItem) return null;
      try {
        const ref = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
        if (ref) {
          await this.bot.equip(tableItem, 'hand');
          await this.bot.placeBlock(ref, { x: 1, y: 0, z: 0 } as any);
        }
      } catch (err) {
        logger.warn('Failed to place crafting table:', err);
      }
      table = this.bot.findBlock({ matching: tableId, maxDistance: 4 });
      if (!table) return null;
    }

    if (this.navigationModule) {
      await this.navigationModule.navigateTo(
        { x: table.position.x, y: table.position.y, z: table.position.z }, signal,
      );
      if (this.isAborted(signal)) return table;
    }
    return table;
  }
}
