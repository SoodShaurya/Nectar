/**
 * minecraft-data recipe wrapper + hardcoded smelting recipes.
 * Provides crafting/smelting recipe lookups by item name.
 */

import minecraftData from 'minecraft-data';

export interface CraftingIngredient {
  item: string;
  count: number;
}

export interface CraftingRecipe {
  ingredients: CraftingIngredient[];
  requiresTable: boolean;
  outputCount: number;
}

export interface SmeltingRecipe {
  input: string;
  output: string;
  outputCount: number;
}

let mcData: ReturnType<typeof minecraftData> | null = null;

export function initRecipes(mcVersion: string): void {
  mcData = minecraftData(mcVersion);
}

/**
 * Look up the first crafting recipe for an item.
 * Returns null if no recipe exists (item must be obtained another way).
 */
export function getCraftingRecipe(itemName: string): CraftingRecipe | null {
  if (!mcData) throw new Error('Recipes not initialized. Call initRecipes() first.');

  const itemData = mcData.itemsByName[itemName];
  if (!itemData) return null;

  const recipes = mcData.recipes[itemData.id];
  if (!recipes || recipes.length === 0) return null;

  // Use the first recipe — cast to any since minecraft-data has complex union types
  const recipe = recipes[0] as any;
  const ingredients = new Map<number, number>(); // itemId → count

  if (recipe.inShape) {
    // Shaped recipe
    for (const row of recipe.inShape) {
      for (const cell of row) {
        if (cell === null || cell === undefined) continue;
        if (typeof cell === 'number') {
          if (cell > 0) ingredients.set(cell, (ingredients.get(cell) ?? 0) + 1);
        } else if (cell.id !== undefined) {
          ingredients.set(cell.id, (ingredients.get(cell.id) ?? 0) + (cell.count ?? 1));
        }
      }
    }
  } else if (recipe.ingredients) {
    // Shapeless recipe
    for (const ing of recipe.ingredients) {
      if (typeof ing === 'number') {
        if (ing > 0) ingredients.set(ing, (ingredients.get(ing) ?? 0) + 1);
      } else if (ing && ing.id !== undefined) {
        ingredients.set(ing.id, (ingredients.get(ing.id) ?? 0) + (ing.count ?? 1));
      }
    }
  }

  if (ingredients.size === 0) return null;

  // Resolve IDs back to names
  const namedIngredients: CraftingIngredient[] = [];
  for (const [id, count] of ingredients) {
    const item = mcData.items[id];
    if (item) {
      namedIngredients.push({ item: item.name, count });
    }
  }

  // Determine if crafting table is needed (3x3 grid recipes need table)
  const requiresTable = recipe.inShape
    ? recipe.inShape.length > 2 || recipe.inShape.some((row: any[]) => row.length > 2)
    : namedIngredients.reduce((sum, i) => sum + i.count, 0) > 4;

  const outputCount = recipe.result?.count ?? 1;

  return {
    ingredients: namedIngredients,
    requiresTable,
    outputCount,
  };
}

// --- Hardcoded Smelting Recipes ---
// minecraft-data doesn't expose smelting recipes in a clean structured format

const SMELTING_RECIPES: SmeltingRecipe[] = [
  // Ores → Ingots/Materials
  { input: 'raw_iron', output: 'iron_ingot', outputCount: 1 },
  { input: 'raw_gold', output: 'gold_ingot', outputCount: 1 },
  { input: 'raw_copper', output: 'copper_ingot', outputCount: 1 },
  { input: 'iron_ore', output: 'iron_ingot', outputCount: 1 },
  { input: 'gold_ore', output: 'gold_ingot', outputCount: 1 },
  { input: 'copper_ore', output: 'copper_ingot', outputCount: 1 },
  { input: 'deepslate_iron_ore', output: 'iron_ingot', outputCount: 1 },
  { input: 'deepslate_gold_ore', output: 'gold_ingot', outputCount: 1 },
  { input: 'deepslate_copper_ore', output: 'copper_ingot', outputCount: 1 },
  { input: 'ancient_debris', output: 'netherite_scrap', outputCount: 1 },
  { input: 'nether_gold_ore', output: 'gold_ingot', outputCount: 1 },

  // Building materials
  { input: 'sand', output: 'glass', outputCount: 1 },
  { input: 'cobblestone', output: 'stone', outputCount: 1 },
  { input: 'stone', output: 'smooth_stone', outputCount: 1 },
  { input: 'clay_ball', output: 'brick', outputCount: 1 },
  { input: 'netherrack', output: 'nether_brick', outputCount: 1 },
  { input: 'stone_bricks', output: 'cracked_stone_bricks', outputCount: 1 },

  // Food
  { input: 'raw_beef', output: 'cooked_beef', outputCount: 1 },
  { input: 'raw_porkchop', output: 'cooked_porkchop', outputCount: 1 },
  { input: 'raw_chicken', output: 'cooked_chicken', outputCount: 1 },
  { input: 'raw_mutton', output: 'cooked_mutton', outputCount: 1 },
  { input: 'raw_rabbit', output: 'cooked_rabbit', outputCount: 1 },
  { input: 'raw_cod', output: 'cooked_cod', outputCount: 1 },
  { input: 'raw_salmon', output: 'cooked_salmon', outputCount: 1 },
  { input: 'potato', output: 'baked_potato', outputCount: 1 },
  { input: 'kelp', output: 'dried_kelp', outputCount: 1 },

  // Misc
  { input: 'wet_sponge', output: 'sponge', outputCount: 1 },
  { input: 'cactus', output: 'green_dye', outputCount: 1 },
  { input: 'chorus_fruit', output: 'popped_chorus_fruit', outputCount: 1 },
];

const smeltingByOutput = new Map<string, SmeltingRecipe>();
for (const r of SMELTING_RECIPES) {
  // Only keep the first (preferred) recipe per output
  if (!smeltingByOutput.has(r.output)) {
    smeltingByOutput.set(r.output, r);
  }
}

/**
 * Look up smelting recipe by OUTPUT item name.
 * Returns null if the item cannot be obtained by smelting.
 */
export function getSmeltingRecipe(outputItemName: string): SmeltingRecipe | null {
  return smeltingByOutput.get(outputItemName) ?? null;
}

/**
 * Check if an item can be obtained by any recipe (crafting or smelting).
 */
export function isObtainableByRecipe(itemName: string): boolean {
  return getCraftingRecipe(itemName) !== null || smeltingByOutput.has(itemName);
}
