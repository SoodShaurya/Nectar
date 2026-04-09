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
    if (!itemData) {
      return this.fail(`Unknown item: ${item}`);
    }

    // Look up recipes
    const recipes = this.bot.recipesFor(itemData.id, null, 1, null);
    if (!recipes || recipes.length === 0) {
      return this.fail(`No recipe found for ${item}`);
    }

    const recipe = recipes[0];

    // Check if we have required ingredients
    const missing = this.checkIngredients(recipe);
    if (missing.length > 0) {
      return this.fail('Missing ingredients', { missing });
    }

    // Check if recipe requires crafting table
    let craftingTable = null;
    if (recipe.requiresTable) {
      craftingTable = this.bot.findBlock({
        matching: this.mcData.blocksByName['crafting_table']?.id,
        maxDistance: 32,
      });

      if (!craftingTable) {
        // Try placing one from inventory
        const tableItem = this.bot.inventory.findInventoryItem(
          this.mcData.itemsByName['crafting_table']?.id, null, false
        );
        if (tableItem) {
          // Place it nearby
          const refBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
          if (refBlock) {
            try {
              await this.bot.equip(tableItem, 'hand');
              await this.bot.placeBlock(refBlock, { x: 1, y: 0, z: 0 } as any);
              craftingTable = this.bot.findBlock({
                matching: this.mcData.blocksByName['crafting_table']?.id,
                maxDistance: 4,
              });
            } catch (err) {
              logger.warn('Failed to place crafting table:', err);
            }
          }
        }

        if (!craftingTable) {
          return this.fail('Recipe requires crafting table but none available');
        }
      }

      // Navigate to crafting table
      if (this.navigationModule && craftingTable) {
        const reached = await this.navigationModule.navigateTo(
          { x: craftingTable.position.x, y: craftingTable.position.y, z: craftingTable.position.z },
          signal
        );
        if (this.isAborted(signal)) return;
        if (!reached) {
          return this.fail('Could not reach crafting table');
        }
      }
    }

    // Craft the item
    try {
      await this.bot.craft(recipe, quantity, craftingTable ?? undefined);
      logger.info(`Crafted ${quantity}x ${item}`);
      this.complete({ item, quantity });
    } catch (err) {
      this.fail(`Crafting failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private checkIngredients(recipe: any): Array<{ item: string; need: number; have: number }> {
    const missing: Array<{ item: string; need: number; have: number }> = [];

    if (!recipe.delta) return missing;

    for (const delta of recipe.delta) {
      if (delta.count < 0) {
        // Ingredient consumed
        const needed = Math.abs(delta.count);
        const have = this.bot.inventory.count(delta.id, null);
        if (have < needed) {
          const itemInfo = this.mcData.items[delta.id];
          missing.push({
            item: itemInfo?.name ?? `id:${delta.id}`,
            need: needed,
            have,
          });
        }
      }
    }

    return missing;
  }
}
