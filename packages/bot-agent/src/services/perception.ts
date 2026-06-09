import { Bot } from 'mineflayer';
import { createLogger } from '@aetherius/shared-types';
import { ReportEventFn } from '../types';

const logger = createLogger('bot-agent:perception');

const PERCEPTION_INTERVAL_MS = 10000;
const PERCEPTION_RADIUS = 16;
const MAX_BLOCKS_PER_SCAN = 50;
const KNOWN_BLOCK_EXPIRY_CYCLES = 3;

const STRATEGIC_RESOURCES = [
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore',
  'coal_ore', 'deepslate_coal_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  'ancient_debris',
  'nether_gold_ore', 'nether_quartz_ore',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
];

const STRATEGIC_POIS = [
  'spawner', 'chest', 'end_portal_frame', 'nether_portal',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'brewing_stand', 'enchanting_table', 'anvil', 'smithing_table',
];

export class PerceptionService {
  private bot: Bot;
  private reportEvent: ReportEventFn;
  private mcData: any = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private knownBlocks: Map<string, number> = new Map(); // key → remaining cycles
  private scanCycle = 0;

  constructor(bot: Bot, reportEvent: ReportEventFn) {
    this.bot = bot;
    this.reportEvent = reportEvent;
  }

  start(): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.bot.once('spawn', () => {
      this.intervalId = setInterval(() => this.scan(), PERCEPTION_INTERVAL_MS);
      logger.info('Perception service started');
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private scan(): void {
    if (!this.bot.entity) return;

    this.scanCycle++;

    // Expire old known blocks
    for (const [key, remaining] of this.knownBlocks) {
      if (remaining <= 0) {
        this.knownBlocks.delete(key);
      } else {
        this.knownBlocks.set(key, remaining - 1);
      }
    }

    // Scan for strategic resources
    for (const resourceName of STRATEGIC_RESOURCES) {
      const blockData = this.mcData.blocksByName[resourceName];
      if (!blockData) continue;

      const found = this.bot.findBlocks({
        matching: blockData.id,
        maxDistance: PERCEPTION_RADIUS,
        count: MAX_BLOCKS_PER_SCAN,
      });

      for (const pos of found) {
        const key = `${pos.x},${pos.y},${pos.z}`;
        if (this.knownBlocks.has(key)) continue;

        this.knownBlocks.set(key, KNOWN_BLOCK_EXPIRY_CYCLES);
        this.reportEvent({
          eventType: 'foundResource',
          details: {
            resourceType: resourceName,
            location: { x: pos.x, y: pos.y, z: pos.z },
            quantityEstimate: found.length,
          },
        });
      }
    }

    // Scan for strategic POIs
    for (const poiName of STRATEGIC_POIS) {
      const blockData = this.mcData.blocksByName[poiName];
      if (!blockData) continue;

      const found = this.bot.findBlocks({
        matching: blockData.id,
        maxDistance: PERCEPTION_RADIUS,
        count: 5,
      });

      for (const pos of found) {
        const key = `poi:${pos.x},${pos.y},${pos.z}`;
        if (this.knownBlocks.has(key)) continue;

        this.knownBlocks.set(key, KNOWN_BLOCK_EXPIRY_CYCLES);
        this.reportEvent({
          eventType: 'foundPOI',
          details: {
            poiType: poiName,
            location: { x: pos.x, y: pos.y, z: pos.z },
          },
        });
      }
    }
  }
}
