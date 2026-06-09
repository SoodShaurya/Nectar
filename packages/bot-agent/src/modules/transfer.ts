import { BaseModule } from './base';
import { ModuleContext } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';

const logger = createLogger('bot-agent:transfer');

export interface TransferParams {
  targetAgent: string;
  targetPosition?: Coordinates; // If known, avoids needing to look up
  items?: Array<{ item: string; count: number }>; // For giving
  receiveMode?: boolean; // If true, agent pathfinds to target and waits
}

export class TransferModule extends BaseModule {
  readonly name = 'transfer';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: TransferParams, signal: AbortSignal): Promise<void> {
    if (params.receiveMode) {
      await this.receiveItems(params, signal);
    } else {
      await this.giveItems(params, signal);
    }
  }

  private async giveItems(params: TransferParams, signal: AbortSignal): Promise<void> {
    const { targetAgent, targetPosition, items } = params;
    if (!items || items.length === 0) {
      return this.fail('No items specified for transfer');
    }

    // Find target agent entity
    let targetPos = targetPosition;
    if (!targetPos) {
      const targetEntity = this.bot.nearestEntity((e) => e.username === targetAgent);
      if (targetEntity) {
        targetPos = {
          x: Math.floor(targetEntity.position.x),
          y: Math.floor(targetEntity.position.y),
          z: Math.floor(targetEntity.position.z),
        };
      }
    }

    if (!targetPos) {
      return this.fail(`Cannot find target agent: ${targetAgent}`);
    }

    // Navigate within 3 blocks
    if (this.navigationModule) {
      const reached = await this.navigationModule.navigateTo(targetPos, signal);
      if (this.isAborted(signal)) return;
      if (!reached) return this.fail('Could not reach target agent');
    }

    // Toss items
    const transferred: Array<{ item: string; count: number }> = [];

    for (const req of items) {
      if (this.isAborted(signal)) return;

      const itemData = this.mcData.itemsByName[req.item];
      if (!itemData) {
        logger.warn(`Unknown item: ${req.item}`);
        continue;
      }

      const invItem = this.bot.inventory.findInventoryItem(itemData.id, null, false);
      if (!invItem) {
        logger.warn(`Item not in inventory: ${req.item}`);
        continue;
      }

      try {
        const tossCount = Math.min(req.count, invItem.count);
        await this.bot.toss(invItem.type, null, tossCount);
        transferred.push({ item: req.item, count: tossCount });
        logger.info(`Tossed ${tossCount}x ${req.item} to ${targetAgent}`);
      } catch (err) {
        logger.warn(`Failed to toss ${req.item}:`, err);
      }
    }

    this.complete({ transferred, targetAgent });
  }

  private async receiveItems(params: TransferParams, signal: AbortSignal): Promise<void> {
    const { targetAgent, targetPosition } = params;

    // Navigate to the giving agent
    let targetPos = targetPosition;
    if (!targetPos) {
      const targetEntity = this.bot.nearestEntity((e) => e.username === targetAgent);
      if (targetEntity) {
        targetPos = {
          x: Math.floor(targetEntity.position.x),
          y: Math.floor(targetEntity.position.y),
          z: Math.floor(targetEntity.position.z),
        };
      }
    }

    if (targetPos && this.navigationModule) {
      await this.navigationModule.navigateTo(targetPos, signal);
      if (this.isAborted(signal)) return;
    }

    // Wait for items to be received (via Mineflayer's auto-collect)
    logger.info(`Waiting to receive items from ${targetAgent}`);

    // Wait up to 30 seconds for items
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 30000);
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    if (this.isAborted(signal)) return;
    this.complete({ receivedFrom: targetAgent });
  }
}
