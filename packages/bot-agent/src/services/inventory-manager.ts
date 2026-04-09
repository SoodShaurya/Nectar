import { Bot } from 'mineflayer';
import { EventEmitter } from 'events';
import { createLogger } from '@aetherius/shared-types';
import { AgentBehaviorProfile } from '../behavior/profile';

const logger = createLogger('bot-agent:inventory');

export class InventoryManager extends EventEmitter {
  private bot: Bot;
  private profile: AgentBehaviorProfile;

  constructor(bot: Bot, profile: AgentBehaviorProfile) {
    super();
    this.bot = bot;
    this.profile = profile;
  }

  start(): void {
    // Inventory full check on every collected item
    this.bot.inventory.on('updateSlot' as any, () => this.checkInventory());
    logger.info('InventoryManager started');
  }

  updateProfile(profile: AgentBehaviorProfile): void {
    this.profile = profile;
  }

  private checkInventory(): void {
    // Check inventory full
    if (this.bot.inventory.emptySlotCount() === 0) {
      this.handleInventoryFull();
    }

    // Check tool minimums
    for (const [toolType, minimum] of Object.entries(this.profile.keepToolsMinimum)) {
      const count = this.bot.inventory.items().filter(i => i.name.includes(toolType)).length;
      if (count < minimum) {
        this.emit('alert', {
          type: 'tool_low',
          toolType,
          currentCount: count,
          threshold: minimum,
        });
      }
    }
  }

  private async handleInventoryFull(): Promise<void> {
    const dropList = this.profile.inventoryDropPriority;
    if (dropList.length === 0) {
      this.emit('alert', {
        type: 'inventory_full',
        itemCounts: this.getItemCounts(),
        dropPriorityAvailable: false,
      });
      return;
    }

    // Drop lowest-priority items first
    for (const itemName of dropList) {
      const item = this.bot.inventory.items().find(i => i.name === itemName);
      if (item) {
        try {
          await this.bot.tossStack(item);
          logger.info(`Auto-dropped ${item.count}x ${item.name}`);
          return; // Freed a slot
        } catch (err) {
          logger.warn(`Failed to drop ${item.name}:`, err);
        }
      }
    }

    // Nothing to drop from priority list
    this.emit('alert', {
      type: 'inventory_full',
      itemCounts: this.getItemCounts(),
      dropPriorityAvailable: false,
    });
  }

  private getItemCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.bot.inventory.items()) {
      counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }
    return counts;
  }
}
