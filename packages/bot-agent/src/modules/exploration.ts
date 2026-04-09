import { BaseModule } from './base';
import { ModuleContext, ReportEventFn } from '../types';
import { Coordinates, createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './navigation';
import { Vec3 } from 'vec3';

const logger = createLogger('bot-agent:exploration');

export interface ExplorationParams {
  goal: 'find_structure' | 'find_block' | 'find_biome' | 'scout_area';
  structureType?: string;
  blockType?: string;
  biomeType?: string;
  dimension?: string;
  searchPattern?: 'expanding_ring' | 'frontier';
  maxRadius?: number;
  radius?: number; // for scout_area
  yRange?: [number, number];
}

export class ExplorationModule extends BaseModule {
  readonly name = 'exploration';
  private mcData: any = null;
  private navigationModule: NavigationModule | null = null;
  private exploredChunks: Set<string> = new Set();

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  initialize(navModule: NavigationModule): void {
    this.mcData = require('minecraft-data')(this.bot.version);
    this.navigationModule = navModule;
  }

  protected async run(params: ExplorationParams, signal: AbortSignal): Promise<void> {
    const { goal, maxRadius = 512, radius = 256 } = params;

    switch (goal) {
      case 'find_structure':
        await this.findStructure(params.structureType!, maxRadius, signal);
        break;
      case 'find_block':
        await this.findBlock(params.blockType!, maxRadius, params.yRange, signal);
        break;
      case 'find_biome':
        await this.findBiome(params.biomeType!, maxRadius, signal);
        break;
      case 'scout_area':
        await this.scoutArea(radius, signal);
        break;
      default:
        this.fail(`Unknown exploration goal: ${goal}`);
    }
  }

  private chunkKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  private markChunkExplored(pos: Vec3): void {
    const cx = Math.floor(pos.x / 16);
    const cz = Math.floor(pos.z / 16);
    this.exploredChunks.add(this.chunkKey(cx, cz));
  }

  private isChunkExplored(cx: number, cz: number): boolean {
    return this.exploredChunks.has(this.chunkKey(cx, cz));
  }

  /** Find nearest unexplored chunk using expanding ring pattern */
  private findNextTarget(origin: Vec3, maxRadius: number): Coordinates | null {
    const chunkRadius = Math.ceil(maxRadius / 16);
    const originCx = Math.floor(origin.x / 16);
    const originCz = Math.floor(origin.z / 16);

    // Expanding ring: check chunks at increasing distance
    for (let ring = 1; ring <= chunkRadius; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          // Only check the perimeter of the ring
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;

          const cx = originCx + dx;
          const cz = originCz + dz;
          if (!this.isChunkExplored(cx, cz)) {
            return { x: cx * 16 + 8, y: Math.floor(origin.y), z: cz * 16 + 8 };
          }
        }
      }
    }
    return null;
  }

  private async findStructure(
    structureType: string, maxRadius: number, signal: AbortSignal
  ): Promise<void> {
    logger.info(`Searching for structure: ${structureType} within ${maxRadius} blocks`);

    // Listen for structure detection from StructureDetector service
    // Meanwhile, explore unexplored chunks
    const origin = this.bot.entity.position.clone();

    while (!this.isAborted(signal)) {
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      this.markChunkExplored(this.bot.entity.position);

      // Check if we've found the structure type in nearby blocks
      // (StructureDetector runs passively on chunk loads and reports POIs)

      const target = this.findNextTarget(origin, maxRadius);
      if (!target) {
        return this.fail(`Explored all chunks within ${maxRadius} blocks, structure not found`);
      }

      const dist = Math.sqrt(
        (target.x - origin.x) ** 2 + (target.z - origin.z) ** 2
      );
      if (dist > maxRadius) {
        return this.fail(`Search exceeded max radius of ${maxRadius} blocks`);
      }

      if (!this.navigationModule) {
        return this.fail('Navigation module not available');
      }

      const reached = await this.navigationModule.navigateTo(target, signal);
      if (this.isAborted(signal)) return;

      if (!reached) {
        // Skip this chunk, try next
        const cx = Math.floor(target.x / 16);
        const cz = Math.floor(target.z / 16);
        this.exploredChunks.add(this.chunkKey(cx, cz));
        continue;
      }

      // Scan nearby blocks for structure signatures after arriving
      // Small delay to let chunks load
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async findBlock(
    blockType: string, maxRadius: number, yRange: [number, number] | undefined, signal: AbortSignal
  ): Promise<void> {
    logger.info(`Searching for block: ${blockType} within ${maxRadius} blocks`);

    const blockData = this.mcData.blocksByName[blockType];
    if (!blockData) {
      return this.fail(`Unknown block type: ${blockType}`);
    }

    const origin = this.bot.entity.position.clone();

    while (!this.isAborted(signal)) {
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      this.markChunkExplored(this.bot.entity.position);

      // Check for the block in loaded chunks
      const found = this.bot.findBlock({
        matching: blockData.id,
        maxDistance: 128,
        count: 1,
      });

      if (found) {
        // Check Y range constraint
        if (!yRange || (found.position.y >= yRange[0] && found.position.y <= yRange[1])) {
          logger.info(`Found ${blockType} at (${found.position.x}, ${found.position.y}, ${found.position.z})`);
          this.reportEvent({
            eventType: 'foundResource',
            details: {
              resourceType: blockType,
              location: { x: found.position.x, y: found.position.y, z: found.position.z },
            },
          });
          return this.complete({
            blockType,
            location: { x: found.position.x, y: found.position.y, z: found.position.z },
          });
        }
      }

      // Move to next unexplored chunk
      const target = this.findNextTarget(origin, maxRadius);
      if (!target) {
        return this.fail(`Block ${blockType} not found within search area`);
      }

      // Adjust Y for yRange search
      if (yRange) {
        target.y = Math.floor((yRange[0] + yRange[1]) / 2);
      }

      if (!this.navigationModule) {
        return this.fail('Navigation module not available');
      }

      const reached = await this.navigationModule.navigateTo(target, signal);
      if (this.isAborted(signal)) return;

      if (!reached) {
        const cx = Math.floor(target.x / 16);
        const cz = Math.floor(target.z / 16);
        this.exploredChunks.add(this.chunkKey(cx, cz));
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  private async findBiome(
    biomeType: string, maxRadius: number, signal: AbortSignal
  ): Promise<void> {
    logger.info(`Searching for biome: ${biomeType} within ${maxRadius} blocks`);
    const origin = this.bot.entity.position.clone();

    while (!this.isAborted(signal)) {
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      this.markChunkExplored(this.bot.entity.position);

      // Check current biome
      const currentBiome = this.bot.blockAt(this.bot.entity.position)?.biome;
      if (currentBiome && (currentBiome as any).name === biomeType) {
        const pos = this.bot.entity.position;
        return this.complete({
          biomeType,
          location: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        });
      }

      const target = this.findNextTarget(origin, maxRadius);
      if (!target) {
        return this.fail(`Biome ${biomeType} not found within search area`);
      }

      if (!this.navigationModule) return this.fail('Navigation module not available');
      await this.navigationModule.navigateTo(target, signal);
      if (this.isAborted(signal)) return;

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  private async scoutArea(radius: number, signal: AbortSignal): Promise<void> {
    logger.info(`Scouting area within ${radius} blocks`);
    const origin = this.bot.entity.position.clone();
    let chunksExplored = 0;

    while (!this.isAborted(signal)) {
      await this.waitWhilePaused();
      if (this.isAborted(signal)) return;

      this.markChunkExplored(this.bot.entity.position);
      chunksExplored++;

      const target = this.findNextTarget(origin, radius);
      if (!target) {
        return this.complete({ chunksExplored, radius });
      }

      if (!this.navigationModule) return this.fail('Navigation module not available');
      const reached = await this.navigationModule.navigateTo(target, signal);
      if (this.isAborted(signal)) return;

      if (!reached) {
        const cx = Math.floor(target.x / 16);
        const cz = Math.floor(target.z / 16);
        this.exploredChunks.add(this.chunkKey(cx, cz));
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
