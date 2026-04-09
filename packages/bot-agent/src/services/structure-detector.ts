import { Bot } from 'mineflayer';
import { createLogger } from '@aetherius/shared-types';
import { ReportEventFn } from '../types';
import { Vec3 } from 'vec3';

const logger = createLogger('bot-agent:structures');

interface StructureSignature {
  name: string;
  signatureBlocks: string[];
  threshold: number;
  searchRadius: number;
  dimension?: string; // "overworld" | "the_nether" | "the_end"
}

const STRUCTURE_SIGNATURES: StructureSignature[] = [
  {
    name: 'nether_fortress',
    signatureBlocks: ['nether_bricks', 'nether_brick_stairs', 'nether_brick_fence'],
    threshold: 20,
    searchRadius: 16,
    dimension: 'the_nether',
  },
  {
    name: 'bastion_remnant',
    signatureBlocks: ['blackstone', 'polished_blackstone_bricks', 'polished_blackstone', 'gilded_blackstone', 'gold_block'],
    threshold: 15,
    searchRadius: 16,
    dimension: 'the_nether',
  },
  {
    name: 'village',
    signatureBlocks: ['bell'],
    threshold: 1,
    searchRadius: 32,
    dimension: 'overworld',
  },
  {
    name: 'dungeon',
    signatureBlocks: ['spawner', 'mossy_cobblestone'],
    threshold: 2, // spawner + mossy cobblestone
    searchRadius: 8,
  },
  {
    name: 'stronghold',
    signatureBlocks: ['end_portal_frame'],
    threshold: 1,
    searchRadius: 16,
  },
  {
    name: 'mineshaft',
    signatureBlocks: ['rail', 'oak_planks'],
    threshold: 5,
    searchRadius: 16,
  },
];

export class StructureDetector {
  private bot: Bot;
  private reportEvent: ReportEventFn;
  private mcData: any = null;
  private detectedStructures: Set<string> = new Set(); // "type:chunkX:chunkZ"
  private agentId: string;

  constructor(bot: Bot, agentId: string, reportEvent: ReportEventFn) {
    this.bot = bot;
    this.agentId = agentId;
    this.reportEvent = reportEvent;
  }

  /** Check if a structure type has been detected in any chunk. */
  hasDetectedStructure(structureType: string): boolean {
    for (const key of this.detectedStructures) {
      if (key.startsWith(structureType + ':')) return true;
    }
    return false;
  }

  start(): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.bot.on('chunkColumnLoad' as any, (point: Vec3) => {
      this.scanChunk(point);
    });
    logger.info('StructureDetector started');
  }

  private scanChunk(chunkPos: Vec3): void {
    const dimension = (this.bot as any).game?.dimension ?? 'overworld';

    for (const sig of STRUCTURE_SIGNATURES) {
      // Filter by dimension if specified
      if (sig.dimension && sig.dimension !== dimension) continue;

      const key = `${sig.name}:${Math.floor(chunkPos.x / 16)}:${Math.floor(chunkPos.z / 16)}`;
      if (this.detectedStructures.has(key)) continue;

      let matchCount = 0;

      for (const blockName of sig.signatureBlocks) {
        const blockData = this.mcData.blocksByName[blockName];
        if (!blockData) continue;

        const found = this.bot.findBlocks({
          matching: blockData.id,
          maxDistance: sig.searchRadius,
          count: sig.threshold,
          point: chunkPos,
        });

        matchCount += found.length;
      }

      if (matchCount >= sig.threshold) {
        this.detectedStructures.add(key);
        const pos = { x: Math.floor(chunkPos.x), y: Math.floor(chunkPos.y), z: Math.floor(chunkPos.z) };

        logger.info(`Detected ${sig.name} near (${pos.x}, ${pos.y}, ${pos.z})`);

        this.reportEvent({
          eventType: 'foundPOI',
          details: {
            poiType: sig.name,
            location: pos,
            details: {
              dimension,
              discoveredBy: this.agentId,
              explored: false,
            },
          },
        });
      }
    }
  }
}
