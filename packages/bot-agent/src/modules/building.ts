import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';
import { Vec3 } from 'vec3';

const logger = createLogger('bot-agent:building');

export interface BuildingParams {
  blocks?: Array<{ pos: Coordinates; block: string }>;
  schematic?: string;
  origin?: Coordinates;
}

// Hardcoded schematics
const SCHEMATICS: Record<string, Array<{ offset: Coordinates; block: string }>> = {
  nether_portal: (() => {
    const blocks: Array<{ offset: Coordinates; block: string }> = [];
    // 4 wide × 5 tall obsidian frame (inside is 2×3 portal)
    // Bottom row
    for (let x = 0; x < 4; x++) blocks.push({ offset: { x, y: 0, z: 0 }, block: 'obsidian' });
    // Sides (y 1-3)
    for (let y = 1; y <= 3; y++) {
      blocks.push({ offset: { x: 0, y, z: 0 }, block: 'obsidian' });
      blocks.push({ offset: { x: 3, y, z: 0 }, block: 'obsidian' });
    }
    // Top row
    for (let x = 0; x < 4; x++) blocks.push({ offset: { x, y: 4, z: 0 }, block: 'obsidian' });
    return blocks;
  })(),
};

export class BuildingModule extends BaseModule {
  readonly name = 'building';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: BuildingParams, signal: AbortSignal): Promise<void> {
    let blockList: Array<{ pos: Coordinates; block: string }>;

    if (params.schematic) {
      const template = SCHEMATICS[params.schematic];
      if (!template) {
        return this.fail(`Unknown schematic: ${params.schematic}`);
      }
      const origin = params.origin ?? {
        x: Math.floor(this.bot.entity.position.x),
        y: Math.floor(this.bot.entity.position.y),
        z: Math.floor(this.bot.entity.position.z + 2),
      };
      blockList = template.map(b => ({
        pos: { x: origin.x + b.offset.x, y: origin.y + b.offset.y, z: origin.z + b.offset.z },
        block: b.block,
      }));
    } else if (params.blocks) {
      blockList = params.blocks;
    } else {
      return this.fail('No blocks or schematic provided');
    }

    // Sort by Y ascending for gravity-safe placement
    blockList.sort((a, b) => a.pos.y - b.pos.y);

    logger.info(`Building ${blockList.length} blocks`);
    let placed = 0;

    for (const entry of blockList) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      const blockData = this.mcData.blocksByName[entry.block];
      if (!blockData) {
        logger.warn(`Unknown block type: ${entry.block}, skipping`);
        continue;
      }

      // Check if block already exists at position
      const existing = this.bot.blockAt(new Vec3(entry.pos.x, entry.pos.y, entry.pos.z));
      if (existing && existing.name === entry.block) {
        placed++;
        continue; // Already placed
      }

      // Equip the block
      const item = this.bot.inventory.findInventoryItem(
        this.mcData.itemsByName[entry.block]?.id, null, false
      );
      if (!item) {
        return this.fail(`Missing block in inventory: ${entry.block}`, {
          placed,
          remaining: blockList.length - placed,
        });
      }

      // Navigate near the target
      if (this.navigationModule) {
        await this.navigationModule.navigateTo(entry.pos, signal);
        if (this.isAborted(signal)) return;
      }

      // Find a reference block to place against
      const targetVec = new Vec3(entry.pos.x, entry.pos.y, entry.pos.z);
      const directions = [
        new Vec3(0, -1, 0), new Vec3(0, 1, 0),
        new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
        new Vec3(0, 0, -1), new Vec3(0, 0, 1),
      ];

      let refBlock = null;
      let faceVec = null;
      for (const dir of directions) {
        const adjPos = targetVec.plus(dir);
        const adj = this.bot.blockAt(adjPos);
        if (adj && adj.name !== 'air' && adj.name !== 'cave_air') {
          refBlock = adj;
          faceVec = dir.scaled(-1); // Face toward the target from the reference
          break;
        }
      }

      if (!refBlock) {
        logger.warn(`No reference block for placement at (${entry.pos.x}, ${entry.pos.y}, ${entry.pos.z}), skipping`);
        continue;
      }

      try {
        await this.bot.equip(item, 'hand');
        await this.bot.placeBlock(refBlock, faceVec!);
        placed++;
        logger.info(`Placed ${placed}/${blockList.length}: ${entry.block}`);
      } catch (err) {
        logger.warn(`Failed to place block at (${entry.pos.x}, ${entry.pos.y}, ${entry.pos.z}):`, err);
      }
    }

    // If nether portal, ignite it
    if (params.schematic === 'nether_portal') {
      await this.ignitePortal(blockList, signal);
    }

    this.complete({ placed, total: blockList.length });
  }

  private async ignitePortal(blocks: Array<{ pos: Coordinates; block: string }>, signal: AbortSignal): Promise<void> {
    const flintAndSteel = this.bot.inventory.findInventoryItem(
      this.mcData.itemsByName['flint_and_steel']?.id, null, false
    );
    if (!flintAndSteel) {
      logger.warn('No flint_and_steel to ignite portal');
      return;
    }

    // Find interior block at y+1 of bottom row
    const bottomBlocks = blocks.filter(b => b.pos.y === Math.min(...blocks.map(bl => bl.pos.y)));
    if (bottomBlocks.length >= 2) {
      const interior = {
        x: bottomBlocks[0].pos.x + 1,
        y: bottomBlocks[0].pos.y + 1,
        z: bottomBlocks[0].pos.z,
      };
      const interiorBlock = this.bot.blockAt(new Vec3(interior.x, interior.y, interior.z));
      if (interiorBlock) {
        try {
          await this.bot.equip(flintAndSteel, 'hand');
          // Activate on the bottom block below the interior
          const bottomBlock = this.bot.blockAt(new Vec3(interior.x, interior.y - 1, interior.z));
          if (bottomBlock) {
            await this.bot.activateBlock(bottomBlock);
            logger.info('Nether portal ignited');
          }
        } catch (err) {
          logger.warn('Failed to ignite portal:', err);
        }
      }
    }
  }
}
