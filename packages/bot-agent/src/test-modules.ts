/**
 * Standalone module test script — no BSM/coordinator needed.
 *
 * Usage: AGENT_ID=TestBot node dist/test-modules.js <nav|gather|explore|craft>
 */

import mineflayer, { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { createLogger } from '@aetherius/shared-types';
import { NavigationModule } from './modules/navigation';
import { GatheringModule } from './modules/gathering';
import { ExplorationModule } from './modules/exploration';
import { CraftingModule } from './modules/crafting';
import { ModuleContext, ReportEventFn } from './types';
import { BaseModule } from './modules/base';

const logger = createLogger('test-modules');

// --- Config from env ---
const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10);
const MC_VERSION = process.env.MC_VERSION || '1.21.9';
const MC_AUTH = process.env.MC_AUTH || 'offline';
const MC_USERNAME = process.env.MC_USERNAME || process.env.AGENT_ID || 'TestBot';
const AGENT_ID = process.env.AGENT_ID || 'TestBot';

const TEST_NAME = process.argv[2];

if (!TEST_NAME || !['nav', 'gather', 'explore', 'craft', 'help'].includes(TEST_NAME)) {
  console.log(`
Module Test Runner
==================
Usage: node dist/test-modules.js <test>

Tests:
  nav      — Navigate 20 blocks (pathfinder sanity check)
  gather   — Dig 3 dirt blocks
  explore  — Scout area (radius=32, ~2 chunk rings)
  craft    — Craft oak_planks from logs

Environment:
  MC_HOST, MC_PORT, MC_VERSION, MC_AUTH, MC_USERNAME, AGENT_ID
`);
  process.exit(0);
}

// --- Stub reportEvent ---
const reportEvent: ReportEventFn = (event) => {
  logger.info(`[EVENT] ${event.eventType}`, event.details ?? {});
};

// --- Test Runner ---
function runModuleTest(
  bot: Bot,
  module: BaseModule,
  params: any,
  timeoutMs: number,
): Promise<{ success: boolean; data: any; startPos: Vec3; endPos: Vec3; distanceMoved: number; durationMs: number }> {
  return new Promise((resolve) => {
    const startPos = bot.entity.position.clone();
    const startTime = Date.now();
    let settled = false;

    // Position polling
    const poller = setInterval(() => {
      const pos = bot.entity.position;
      const dist = startPos.distanceTo(pos);
      logger.info(`[POS] (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) — moved ${dist.toFixed(1)} blocks`);
    }, 5000);

    const settle = (success: boolean, data: any) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timeout);
      const endPos = bot.entity.position.clone();
      const distanceMoved = startPos.distanceTo(endPos);
      const durationMs = Date.now() - startTime;
      resolve({ success, data, startPos, endPos, distanceMoved, durationMs });
    };

    module.on('complete', (data: any) => {
      logger.info(`[MODULE] Complete`, data);
      settle(true, data);
    });

    module.on('failed', (data: any) => {
      logger.error(`[MODULE] Failed`, data);
      settle(false, data);
    });

    const timeout = setTimeout(() => {
      logger.warn(`[TIMEOUT] Test timed out after ${timeoutMs}ms`);
      module.deactivate();
      settle(false, { reason: 'timeout' });
    }, timeoutMs);

    logger.info(`[START] Activating module with params:`, params);
    module.activate(params);
  });
}

// --- Individual Tests ---

async function testNavigation(bot: Bot, navModule: NavigationModule): Promise<boolean> {
  console.log('\n========== TEST: Navigation ==========');
  const pos = bot.entity.position;
  const target = { x: Math.floor(pos.x) + 20, y: Math.floor(pos.y), z: Math.floor(pos.z) };
  logger.info(`Current pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
  logger.info(`Target: (${target.x}, ${target.y}, ${target.z})`);

  const result = await runModuleTest(bot, navModule, { destination: target }, 30000);

  console.log('\n--- Navigation Result ---');
  console.log(`  Success: ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Distance moved: ${result.distanceMoved.toFixed(1)} blocks`);
  console.log(`  Start: (${result.startPos.x.toFixed(1)}, ${result.startPos.y.toFixed(1)}, ${result.startPos.z.toFixed(1)})`);
  console.log(`  End:   (${result.endPos.x.toFixed(1)}, ${result.endPos.y.toFixed(1)}, ${result.endPos.z.toFixed(1)})`);

  const pass = result.success && result.distanceMoved > 10;
  console.log(`  PASS: ${pass ? 'YES' : 'NO'}`);
  return pass;
}

async function testGathering(bot: Bot, gatherModule: GatheringModule): Promise<boolean> {
  console.log('\n========== TEST: Gathering ==========');

  // Count dirt before
  const dirtBefore = bot.inventory.items().filter(i => i.name === 'dirt').reduce((s, i) => s + i.count, 0);
  logger.info(`Dirt in inventory before: ${dirtBefore}`);

  const result = await runModuleTest(bot, gatherModule, {
    targetType: 'block',
    target: 'dirt',
    quantity: 3,
    searchRadius: 32,
  }, 60000);

  const dirtAfter = bot.inventory.items().filter(i => i.name === 'dirt').reduce((s, i) => s + i.count, 0);

  console.log('\n--- Gathering Result ---');
  console.log(`  Success: ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Distance moved: ${result.distanceMoved.toFixed(1)} blocks`);
  console.log(`  Dirt before: ${dirtBefore}, after: ${dirtAfter}, gained: ${dirtAfter - dirtBefore}`);
  console.log(`  Data:`, result.data);

  const pass = result.success && dirtAfter > dirtBefore;
  console.log(`  PASS: ${pass ? 'YES' : 'NO'}`);
  return pass;
}

async function testExploration(bot: Bot, exploreModule: ExplorationModule, navModule: NavigationModule): Promise<boolean> {
  console.log('\n========== TEST: Exploration ==========');

  // Instrument navigateTo for diagnostics
  const origNavigateTo = navModule.navigateTo.bind(navModule);
  let navCallCount = 0;
  navModule.navigateTo = async (coords, signal) => {
    navCallCount++;
    const pos = bot.entity.position;
    logger.info(`[NAV #${navCallCount}] navigateTo(${coords.x}, ${coords.y}, ${coords.z}) — bot at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
    try {
      const result = await origNavigateTo(coords, signal);
      const newPos = bot.entity.position;
      logger.info(`[NAV #${navCallCount}] returned ${result} — bot now at (${newPos.x.toFixed(1)}, ${newPos.y.toFixed(1)}, ${newPos.z.toFixed(1)})`);
      return result;
    } catch (err: any) {
      logger.error(`[NAV #${navCallCount}] threw: ${err.message}`);
      return false;
    }
  };

  const result = await runModuleTest(bot, exploreModule, {
    goal: 'scout_area',
    radius: 32,
  }, 120000);

  // Restore original
  navModule.navigateTo = origNavigateTo;

  console.log('\n--- Exploration Result ---');
  console.log(`  Success: ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Distance moved: ${result.distanceMoved.toFixed(1)} blocks`);
  console.log(`  NavigateTo calls: ${navCallCount}`);
  console.log(`  Data:`, result.data);

  const pass = result.success && result.distanceMoved > 10;
  console.log(`  PASS: ${pass ? 'YES' : 'NO'}`);
  if (!pass && result.durationMs < 5000) {
    console.log(`  DIAGNOSTIC: Test completed in <5s — likely all navigateTo calls failed/returned false`);
  }
  return pass;
}

async function testCrafting(bot: Bot, craftModule: CraftingModule): Promise<boolean> {
  console.log('\n========== TEST: Crafting ==========');

  // Check for logs
  const logTypes = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
  const logs = bot.inventory.items().filter(i => logTypes.includes(i.name));
  if (logs.length === 0) {
    console.log('  SKIP: No logs in inventory. Gather logs first.');
    return false;
  }

  const logName = logs[0].name;
  const plankName = logName.replace('_log', '_planks');
  logger.info(`Using ${logName} → ${plankName}`);

  const planksBefore = bot.inventory.items().filter(i => i.name === plankName).reduce((s, i) => s + i.count, 0);

  const result = await runModuleTest(bot, craftModule, {
    item: plankName,
    quantity: 4,
  }, 30000);

  const planksAfter = bot.inventory.items().filter(i => i.name === plankName).reduce((s, i) => s + i.count, 0);

  console.log('\n--- Crafting Result ---');
  console.log(`  Success: ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  ${plankName} before: ${planksBefore}, after: ${planksAfter}`);
  console.log(`  Data:`, result.data);

  const pass = result.success && planksAfter > planksBefore;
  console.log(`  PASS: ${pass ? 'YES' : 'NO'}`);
  return pass;
}

// --- Main ---

async function main(): Promise<void> {
  logger.info(`Connecting to ${MC_HOST}:${MC_PORT} (v${MC_VERSION}, auth=${MC_AUTH})`);

  const botOptions: any = {
    host: MC_HOST,
    port: MC_PORT,
    username: MC_AUTH === 'microsoft' ? MC_USERNAME : AGENT_ID,
    version: MC_VERSION,
    checkTimeoutInterval: 60 * 1000,
  };

  if (MC_AUTH === 'microsoft') {
    botOptions.auth = 'microsoft';
  }

  const bot = mineflayer.createBot(botOptions);

  bot.on('error', (err: Error) => {
    logger.error('Bot error:', err.message);
  });

  bot.on('kicked', (reason: string) => {
    logger.error('Bot kicked:', reason);
    process.exit(1);
  });

  bot.on('death', () => {
    logger.warn('Bot died! Auto-respawning...');
    // Auto-respawn after a short delay
    setTimeout(() => {
      try {
        (bot as any).respawn?.();
      } catch (e) {
        // Some versions handle respawn differently
      }
    }, 1000);
  });

  bot.on('end', (reason: string) => {
    logger.error('Bot connection ended:', reason);
    process.exit(1);
  });

  bot.once('spawn', async () => {
    logger.info(`Bot spawned at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);

    // Pathfinder is loaded by NavigationModule.initialize()
    logger.info('Pathfinder will be loaded by NavigationModule');

    // Load tool plugin
    try {
      const toolPlugin = require('mineflayer-tool').plugin;
      bot.loadPlugin(toolPlugin);
    } catch (err) {
      logger.warn('mineflayer-tool plugin not loaded (gathering may not auto-equip tools)');
    }

    // Wait for chunks to load
    logger.info('Waiting 3s for chunks to load...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Create module context
    const ctx: ModuleContext = { bot, reportEvent };

    // Initialize modules
    const navModule = new NavigationModule(ctx);
    navModule.initialize();

    const gatherModule = new GatheringModule(ctx);
    gatherModule.initialize(navModule);

    const exploreModule = new ExplorationModule(ctx);
    exploreModule.initialize(navModule);

    const craftModule = new CraftingModule(ctx);
    craftModule.initialize(navModule);

    // Run selected test
    let pass = false;
    try {
      switch (TEST_NAME) {
        case 'nav':
          pass = await testNavigation(bot, navModule);
          break;
        case 'gather':
          pass = await testGathering(bot, gatherModule);
          break;
        case 'explore':
          pass = await testExploration(bot, exploreModule, navModule);
          break;
        case 'craft':
          pass = await testCrafting(bot, craftModule);
          break;
      }
    } catch (err: any) {
      logger.error('Test threw:', err.message, err.stack);
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Test "${TEST_NAME}": ${pass ? 'PASSED' : 'FAILED'}`);
    console.log(`${'='.repeat(40)}\n`);

    bot.quit();
    setTimeout(() => process.exit(pass ? 0 : 1), 1000);
  });
}

main().catch((err) => {
  logger.error('Fatal:', err);
  process.exit(1);
});
