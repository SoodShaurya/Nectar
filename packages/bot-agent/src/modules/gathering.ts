import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';
import { ExplorationModule } from './exploration';

const logger = createLogger('bot-agent:gathering');

export interface GatheringParams {
  targetType: 'block' | 'entity' | 'fishing';
  target: string;       // block name (e.g., "iron_ore") or entity type (e.g., "cow")
  quantity: number;
  maxY?: number;
  searchRadius?: number;
}

// How long to chase/collect drops after a block break or mob kill.
// Generous because baritone pathing to a fallen item can take many seconds.
const COLLECT_TIMEOUT_MS = 15000;
const DROP_SEARCH_RADIUS = 12;
const KILL_TIMEOUT_MS = 15000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_RELOCATIONS = 4; // how many times to travel to a new area when targets are unreachable

export class GatheringModule extends BaseModule {
  readonly name = 'gathering';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;
  private explorationModule: ExplorationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule, explorationModule?: ExplorationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
    this.explorationModule = explorationModule ?? null;
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

  // --- Helpers ---

  /** Total item count across the inventory. */
  private totalItems(): number {
    return this.bot.inventory.items().reduce((s, i) => s + i.count, 0);
  }

  /** Count of a specific item by name. */
  private countByName(name: string): number {
    return this.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
  }

  /** Best-effort resolution of the item a block drops when mined (e.g. stone -> cobblestone). */
  private dropItemName(blockData: any): string | null {
    try {
      const drops = blockData?.drops;
      if (Array.isArray(drops) && drops.length > 0) {
        const d = drops[0];
        const id = typeof d === 'number' ? d : (d?.drop?.id ?? d?.drop ?? d?.item ?? d?.id);
        if (typeof id === 'number') return this.mcData.items[id]?.name ?? null;
        if (typeof id === 'string') return id;
      }
    } catch { /* fall through */ }
    return null;
  }

  /** Is this entity a dropped item? (avoid the deprecated `objectType` accessor) */
  private isItemEntity(e: any): boolean {
    return !!e && e.name === 'item';
  }

  private dropDiagDone = false;

  /**
   * Walk to and pick up dropped items near `center`. Items auto-collect on
   * proximity, so navigating onto each drop is enough. Returns when no drops
   * remain nearby or the timeout elapses.
   */
  private async collectNearbyDrops(center: any, signal: AbortSignal): Promise<void> {
    // Walk ONTO the break location first (tolerance 1 = within pickup range;
    // the default tolerance of 2 parks the bot just outside it). Items
    // auto-collect on proximity and the drop is usually right where the block was.
    if (this.navigationModule) {
      await this.navigationModule.navigateTo({ x: center.x, y: center.y, z: center.z }, signal, 1);
      await this.sleep(250);
    }

    // One-shot diagnostic: what entities are actually near a fresh break?
    if (!this.dropDiagDone) {
      this.dropDiagDone = true;
      const near = Object.values(this.bot.entities)
        .filter((e: any) => e?.position && center.distanceTo(e.position) <= DROP_SEARCH_RADIUS)
        .map((e: any) => e.name);
      logger.info(`[diag] entities within ${DROP_SEARCH_RADIUS} of break: ${JSON.stringify(near)}`);
    }

    const deadline = Date.now() + COLLECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.isAborted(signal)) return;

      const drop = this.bot.nearestEntity(
        (e: any) => this.isItemEntity(e) && e.position && center.distanceTo(e.position) <= DROP_SEARCH_RADIUS,
      );
      if (!drop) {
        // The drop entity may not have spawned yet right after the break.
        await this.sleep(250);
        const retry = this.bot.nearestEntity(
          (e: any) => this.isItemEntity(e) && e.position && center.distanceTo(e.position) <= DROP_SEARCH_RADIUS,
        );
        if (!retry) return;
        continue;
      }

      if (this.navigationModule) {
        await this.navigationModule.navigateTo(
          { x: drop.position.x, y: drop.position.y, z: drop.position.z },
          signal, 1,
        );
      }
      // Give the server a tick to register the pickup.
      await this.sleep(300);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Travel to a new area via the exploration module when targets are unreachable here. */
  private async tryRelocate(blockName: string, signal: AbortSignal, relocations: number): Promise<boolean> {
    if (!this.explorationModule || relocations >= MAX_RELOCATIONS) return false;
    logger.info(`No reachable ${blockName} nearby; relocating via exploration (${relocations + 1}/${MAX_RELOCATIONS})`);
    return this.explorationModule.seekBlock(blockName, signal, { maxHops: 12 });
  }

  // --- Block gathering ---

  private async gatherBlocks(
    blockName: string, quantity: number, maxY: number | undefined,
    searchRadius: number, signal: AbortSignal,
  ): Promise<void> {
    const blockData = this.mcData.blocksByName[blockName];
    if (!blockData) {
      return this.fail(`Unknown block type: ${blockName}`);
    }

    const dropName = this.dropItemName(blockData); // what a mined block yields; may be null
    let gathered = 0;            // counts ACTUAL items collected, not blocks broken
    let consecutiveFailures = 0;
    let relocations = 0;
    const failed = new Set<string>(); // positions we couldn't reach/mine — don't retry them
    logger.info(`Gathering ${quantity}x ${blockName}${dropName && dropName !== blockName ? ` (drops ${dropName})` : ''}`);

    while (gathered < quantity) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (await this.tryRelocate(blockName, signal, relocations)) {
          relocations++; failed.clear(); consecutiveFailures = 0; continue;
        }
        if (this.isAborted(signal)) return;
        if (gathered > 0) return this.complete({ gathered, target: blockName });
        return this.fail(`Gave up after ${consecutiveFailures} consecutive failures`, { gathered });
      }

      // Find candidates (nearest first), skipping ones that already failed and
      // honoring the maxY constraint. Prefer ones near the bot's elevation — a
      // base-of-trunk log is reachable; a canopy log at Y74 is not.
      const botY = this.bot.entity.position.y;
      const candidates = this.bot
        .findBlocks({ matching: blockData.id, maxDistance: searchRadius, count: 256 })
        .filter((pos) => (maxY === undefined || pos.y <= maxY) && !failed.has(`${pos.x},${pos.y},${pos.z}`));
      const chosen = candidates.find((pos) => Math.abs(pos.y - botY) <= 6) ?? candidates[0];

      if (!chosen) {
        // Nothing reachable here — travel to a new area (wire in exploration).
        if (await this.tryRelocate(blockName, signal, relocations)) {
          relocations++; failed.clear(); consecutiveFailures = 0; continue;
        }
        if (this.isAborted(signal)) return;
        if (gathered > 0) return this.complete({ gathered, target: blockName });
        const where = maxY !== undefined ? ` below Y=${maxY}` : '';
        return this.fail(`No reachable ${blockName} found within ${searchRadius} blocks${where}`, { gathered });
      }

      const posKey = `${chosen.x},${chosen.y},${chosen.z}`;
      const block = this.bot.blockAt(chosen);
      if (!block) { failed.add(posKey); consecutiveFailures++; continue; }

      // Navigate to the block. A nav failure is not fatal — mark it failed (so we
      // don't re-pick it) and try another. Short timeout so an unreachable/buried
      // block doesn't burn 60s.
      if (!this.navigationModule) return this.fail('Navigation module not available');
      const reached = await this.navigationModule.navigateTo(
        { x: block.position.x, y: block.position.y, z: block.position.z }, signal, 2,
      );
      if (this.isAborted(signal)) return;
      if (!reached) {
        logger.warn(`Could not reach ${blockName} at ${block.position}; skipping`);
        failed.add(posKey);
        consecutiveFailures++;
        continue;
      }

      // Equip the best tool. If we can't (and the block needs one to drop), skip
      // rather than mining it into nothing.
      let equipped = true;
      try {
        const toolPlugin = (this.bot as any).tool;
        if (toolPlugin) await toolPlugin.equipForBlock(block);
      } catch (err) {
        equipped = false;
        logger.warn('Failed to equip best tool:', err);
      }
      if (!equipped && !this.bot.canDigBlock(block)) {
        consecutiveFailures++;
        continue;
      }

      // Dig, then actually collect the drop and verify the inventory grew.
      const before = dropName ? this.countByName(dropName) : this.totalItems();
      try {
        await this.bot.dig(block);
      } catch (err) {
        logger.error(`Failed to dig ${blockName}:`, err);
        consecutiveFailures++;
        continue;
      }

      await this.collectNearbyDrops(block.position, signal);
      if (this.isAborted(signal)) return;

      const after = dropName ? this.countByName(dropName) : this.totalItems();
      const got = after - before;
      if (got > 0) {
        gathered += got;
        consecutiveFailures = 0;
        logger.info(`Gathered ${gathered}/${quantity} ${dropName ?? blockName}`);
      } else {
        // Broke the block but collected nothing (wrong tool, drop lost, lava, etc.).
        consecutiveFailures++;
        logger.warn(`Broke ${blockName} but collected no drop (attempt ${consecutiveFailures})`);
      }

      if (this.bot.inventory.emptySlotCount() === 0) {
        this.alert({ type: 'inventory_full', gathered });
        return this.fail('Inventory full', { gathered });
      }
    }

    this.complete({ gathered, target: blockName });
  }

  // --- Entity gathering ---

  private async gatherFromEntities(
    entityType: string, quantity: number, signal: AbortSignal,
  ): Promise<void> {
    let gathered = 0;              // ACTUAL drop items collected
    let consecutiveFailures = 0;
    logger.info(`Gathering ${quantity}x drops from ${entityType}`);
    const pvp = (this.bot as any).swordpvp || (this.bot as any).pvp;

    try {
      while (gathered < quantity) {
        if (this.isAborted(signal)) return;
        await this.waitWhilePaused();
        if (this.isAborted(signal)) return;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          if (gathered > 0) return this.complete({ gathered, target: entityType });
          return this.fail(`Gave up after ${consecutiveFailures} consecutive failures`, { gathered });
        }

        const entity = this.bot.nearestEntity((e: any) => e.name === entityType && e.type === 'mob');
        if (!entity) {
          if (gathered > 0) return this.complete({ gathered, target: entityType });
          return this.fail(`No ${entityType} found nearby`, { gathered });
        }
        const targetId = entity.id;

        if (!this.navigationModule) return this.fail('Navigation module not available');
        const reached = await this.navigationModule.navigateTo(
          { x: entity.position.x, y: entity.position.y, z: entity.position.z }, signal,
        );
        if (this.isAborted(signal)) return;
        if (!reached) { consecutiveFailures++; continue; }

        // Attack until the entity is actually dead (swordpvp.attack is non-blocking).
        const before = this.totalItems();
        const lastPos = entity.position.clone();
        try { if (pvp?.attack) await pvp.attack(entity); } catch { /* keep going with manual attacks */ }

        const killDeadline = Date.now() + KILL_TIMEOUT_MS;
        while (Date.now() < killDeadline) {
          if (this.isAborted(signal)) { try { pvp?.stop?.(); } catch {} return; }
          const e = this.bot.entities[targetId];
          if (!e || e.isValid === false) break; // dead / despawned
          lastPos.update(e.position);
          if (!pvp?.attack) { try { this.bot.attack(e); } catch {} }
          await this.sleep(400);
        }
        try { pvp?.stop?.(); } catch {}

        // Collect whatever it dropped.
        await this.collectNearbyDrops(lastPos, signal);
        if (this.isAborted(signal)) return;

        const got = this.totalItems() - before;
        if (got > 0) {
          gathered += got;
          consecutiveFailures = 0;
          logger.info(`Gathered ${gathered}/${quantity} from ${entityType}`);
        } else {
          consecutiveFailures++;
          logger.warn(`Killed/attacked ${entityType} but collected no drop (attempt ${consecutiveFailures})`);
        }
      }
    } finally {
      try { pvp?.stop?.(); } catch {}
    }

    this.complete({ gathered, target: entityType });
  }

  // --- Fishing ---

  private async gatherByFishing(quantity: number, signal: AbortSignal): Promise<void> {
    let caught = 0; // ACTUAL items reeled in
    logger.info(`Fishing for ${quantity} catches`);

    const waterBlockData = this.mcData.blocksByName['water'];
    if (!waterBlockData) return this.fail('Cannot find water block data');

    const water = this.bot.findBlock({ matching: waterBlockData.id, maxDistance: 32, count: 1 });
    if (!water) return this.fail('No water found within 32 blocks');

    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(
        { x: water.position.x, y: water.position.y + 1, z: water.position.z }, signal,
      );
      if (this.isAborted(signal)) return;
      if (!reached) return this.fail('Could not reach water');
    }

    const rod = this.bot.inventory.items().find((i) => i.name === 'fishing_rod');
    if (!rod) return this.fail('No fishing rod in inventory');
    try {
      await this.bot.equip(rod, 'hand');
    } catch (err) {
      return this.fail(`Failed to equip fishing rod: ${err}`);
    }

    while (caught < quantity) {
      if (this.isAborted(signal)) return;
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      const before = this.totalItems();
      try {
        await this.bot.fish();
      } catch (err) {
        logger.warn('Fishing attempt failed:', err);
        await this.sleep(1000);
        continue;
      }
      const got = this.totalItems() - before;
      if (got > 0) {
        caught += got;
        logger.info(`Caught ${caught}/${quantity}`);
      }

      if (this.bot.inventory.emptySlotCount() === 0) {
        this.alert({ type: 'inventory_full', caught });
        return this.fail('Inventory full', { caught });
      }
    }

    this.complete({ caught, target: 'fish' });
  }
}
