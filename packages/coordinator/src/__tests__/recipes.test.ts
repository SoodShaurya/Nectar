import { describe, it, expect, beforeAll } from 'vitest';
import { initRecipes, getCraftingRecipe, getSmeltingRecipe, isObtainableByRecipe } from '../task-tree/recipes';

beforeAll(() => {
  initRecipes('1.21.1');
});

describe('Recipes - Crafting', () => {
  it('resolves crafting_table recipe (4 planks)', () => {
    const recipe = getCraftingRecipe('crafting_table');
    expect(recipe).not.toBeNull();
    expect(recipe!.outputCount).toBeGreaterThanOrEqual(1);
    expect(recipe!.ingredients.length).toBeGreaterThan(0);
    // Crafting table needs planks
    const hasPlankIngredient = recipe!.ingredients.some(i => i.item.includes('planks'));
    expect(hasPlankIngredient).toBe(true);
  });

  it('resolves stick recipe', () => {
    const recipe = getCraftingRecipe('stick');
    expect(recipe).not.toBeNull();
    expect(recipe!.outputCount).toBeGreaterThanOrEqual(1);
    expect(recipe!.ingredients.length).toBeGreaterThan(0);
  });

  it('resolves wooden_pickaxe recipe', () => {
    const recipe = getCraftingRecipe('wooden_pickaxe');
    expect(recipe).not.toBeNull();
    // Needs planks and sticks
    const items = recipe!.ingredients.map(i => i.item);
    expect(items.some(i => i.includes('planks'))).toBe(true);
    expect(items.some(i => i === 'stick')).toBe(true);
  });

  it('resolves iron_pickaxe recipe', () => {
    const recipe = getCraftingRecipe('iron_pickaxe');
    expect(recipe).not.toBeNull();
    const items = recipe!.ingredients.map(i => i.item);
    expect(items).toContain('iron_ingot');
    expect(items).toContain('stick');
  });

  it('resolves diamond_chestplate recipe', () => {
    const recipe = getCraftingRecipe('diamond_chestplate');
    expect(recipe).not.toBeNull();
    const diamondIng = recipe!.ingredients.find(i => i.item === 'diamond');
    expect(diamondIng).toBeDefined();
    expect(diamondIng!.count).toBe(8);
  });

  it('returns null for items with no crafting recipe', () => {
    expect(getCraftingRecipe('oak_log')).toBeNull();
    expect(getCraftingRecipe('blaze_rod')).toBeNull();
    expect(getCraftingRecipe('ender_pearl')).toBeNull();
    expect(getCraftingRecipe('cobblestone')).toBeNull();
  });

  it('returns a recipe for diamond (diamond_block decomposition exists)', () => {
    // diamond CAN be crafted from diamond_block — this is correct minecraft-data behavior
    // The resolver handles this by checking mining sources BEFORE crafting recipes
    const recipe = getCraftingRecipe('diamond');
    expect(recipe).not.toBeNull();
    expect(recipe!.outputCount).toBe(9);
  });

  it('returns null for nonexistent items', () => {
    expect(getCraftingRecipe('not_a_real_item')).toBeNull();
  });
});

describe('Recipes - Smelting', () => {
  it('resolves iron_ingot smelting from raw_iron', () => {
    const recipe = getSmeltingRecipe('iron_ingot');
    expect(recipe).not.toBeNull();
    expect(recipe!.input).toBe('raw_iron');
    expect(recipe!.output).toBe('iron_ingot');
  });

  it('resolves gold_ingot smelting', () => {
    const recipe = getSmeltingRecipe('gold_ingot');
    expect(recipe).not.toBeNull();
    expect(recipe!.input).toBe('raw_gold');
  });

  it('resolves netherite_scrap smelting from ancient_debris', () => {
    const recipe = getSmeltingRecipe('netherite_scrap');
    expect(recipe).not.toBeNull();
    expect(recipe!.input).toBe('ancient_debris');
  });

  it('resolves cooked_beef smelting', () => {
    const recipe = getSmeltingRecipe('cooked_beef');
    expect(recipe).not.toBeNull();
    expect(recipe!.input).toBe('raw_beef');
  });

  it('resolves glass from sand', () => {
    const recipe = getSmeltingRecipe('glass');
    expect(recipe).not.toBeNull();
    expect(recipe!.input).toBe('sand');
  });

  it('returns null for non-smeltable items', () => {
    expect(getSmeltingRecipe('diamond')).toBeNull();
    expect(getSmeltingRecipe('stick')).toBeNull();
  });
});

describe('isObtainableByRecipe', () => {
  it('returns true for craftable items', () => {
    expect(isObtainableByRecipe('crafting_table')).toBe(true);
    expect(isObtainableByRecipe('stick')).toBe(true);
    expect(isObtainableByRecipe('iron_pickaxe')).toBe(true);
  });

  it('returns true for smeltable items', () => {
    expect(isObtainableByRecipe('iron_ingot')).toBe(true);
    expect(isObtainableByRecipe('glass')).toBe(true);
  });

  it('returns false for items with no recipe at all', () => {
    expect(isObtainableByRecipe('oak_log')).toBe(false);
    expect(isObtainableByRecipe('blaze_rod')).toBe(false);
    expect(isObtainableByRecipe('ender_pearl')).toBe(false);
    expect(isObtainableByRecipe('cobblestone')).toBe(false);
  });

  it('returns true for diamond (has crafting recipe from diamond_block)', () => {
    // The resolver handles priority (mining > crafting), but the recipe exists
    expect(isObtainableByRecipe('diamond')).toBe(true);
  });
});
