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
import { SmeltingModule } from './modules/smelting';
import { ModuleContext, ReportEventFn } from './types';
import { BaseModule } from './modules/base';
import { BehaviorLayer } from './behavior/layer';

// Behavior layer (survival/combat) — wired into runModuleTest so the bot defends
// itself during tasks, like production. Without it the bot dies to mobs.
let behaviorLayer: BehaviorLayer | null = null;

const logger = createLogger('test-modules');

// --- Config from env ---
const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10);
const MC_VERSION = process.env.MC_VERSION || '1.21.11';
const MC_AUTH = process.env.MC_AUTH || 'offline';
const MC_USERNAME = process.env.MC_USERNAME || process.env.AGENT_ID || 'TestBot';
const AGENT_ID = process.env.AGENT_ID || 'TestBot';

// Per-test param overrides (avoid recompiling to iterate)
const TARGET = process.env.TARGET;           // gather: block/entity name
const QTY = process.env.QTY ? parseInt(process.env.QTY, 10) : undefined;
const ITEM = process.env.ITEM;               // craft: item name
const INPUT = process.env.INPUT;             // smelt: input item
const FUEL = process.env.FUEL || 'coal';     // smelt: fuel item

const TEST_NAME = process.argv[2];

if (!TEST_NAME || !['nav', 'gather', 'explore', 'craft', 'smelt', 'loop', 'smeltchain', 'help'].includes(TEST_NAME)) {
  console.log(`
Module Test Runner
==================
Usage: node dist/test-modules.js <test>

Tests:
  nav      — Navigate 20 blocks (pathfinder sanity check)
  gather   — Gather blocks (env: TARGET=dirt QTY=3)
  explore  — Scout area (radius=32, ~2 chunk rings)
  craft    — Craft an item (env: ITEM=oak_planks QTY=4; defaults to planks from held logs)
  smelt    — Smelt (env: INPUT=raw_iron FUEL=coal QTY=1)

Environment:
  MC_HOST, MC_PORT, MC_VERSION, MC_AUTH, MC_USERNAME, AGENT_ID
  TARGET, QTY, ITEM, INPUT, FUEL
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
      behaviorLayer?.setActiveModule(null);
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
    behaviorLayer?.setActiveModule(module);
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

const countItem = (bot: Bot, name: string) =>
  bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);

async function testGathering(bot: Bot, gatherModule: GatheringModule): Promise<boolean> {
  console.log('\n========== TEST: Gathering ==========');

  const target = TARGET || 'dirt';
  const quantity = QTY || 3;
  const before = countItem(bot, target);
  logger.info(`${target} in inventory before: ${before} (goal: +${quantity})`);

  const result = await runModuleTest(bot, gatherModule, {
    targetType: 'block',
    target,
    quantity,
    searchRadius: 48,
  }, 120000);

  const after = countItem(bot, target);

  console.log('\n--- Gathering Result ---');
  console.log(`  Success(reported): ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Distance moved: ${result.distanceMoved.toFixed(1)} blocks`);
  console.log(`  ${target} before: ${before}, after: ${after}, ACTUALLY gained: ${after - before}`);
  console.log(`  Data:`, result.data);

  // Truth = real inventory delta, not the module's self-reported success.
  const pass = (after - before) >= quantity;
  console.log(`  PASS (real inventory +${quantity}): ${pass ? 'YES' : 'NO'}`);
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

  let item = ITEM;
  let quantity = QTY || 4;
  if (!item) {
    // Default: planks from whatever logs we hold.
    const logTypes = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
    const logs = bot.inventory.items().filter(i => logTypes.includes(i.name));
    if (logs.length === 0) {
      console.log('  SKIP: No logs in inventory and no ITEM set. Gather logs first.');
      return false;
    }
    item = logs[0].name.replace('_log', '_planks');
    logger.info(`Using ${logs[0].name} → ${item}`);
  }

  const before = countItem(bot, item);

  const result = await runModuleTest(bot, craftModule, { item, quantity }, 45000);

  const after = countItem(bot, item);

  console.log('\n--- Crafting Result ---');
  console.log(`  Success(reported): ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  ${item} before: ${before}, after: ${after} (ACTUALLY +${after - before})`);
  console.log(`  Data:`, result.data);

  const pass = (after - before) >= quantity;
  console.log(`  PASS (real ${item} +${quantity}): ${pass ? 'YES' : 'NO'}`);
  return pass;
}

async function testSmelting(bot: Bot, smeltModule: SmeltingModule): Promise<boolean> {
  console.log('\n========== TEST: Smelting ==========');

  const input = INPUT || 'raw_iron';
  const fuel = FUEL;
  const quantity = QTY || 1;
  // Predict the smelted output name for the inventory-delta check.
  const OUTPUT_MAP: Record<string, string> = {
    raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
    sand: 'glass', cobblestone: 'stone', oak_log: 'charcoal', beef: 'cooked_beef',
    porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', potato: 'baked_potato',
  };
  const output = OUTPUT_MAP[input] || 'iron_ingot';

  const inBefore = countItem(bot, input);
  const outBefore = countItem(bot, output);
  logger.info(`Smelt ${quantity}x ${input} (+${fuel}) -> ${output}. have input=${inBefore}, output=${outBefore}`);
  if (inBefore < quantity) console.log(`  NOTE: only ${inBefore} ${input} on hand (need ${quantity}) — module should fail cleanly.`);
  if (countItem(bot, fuel) < 1) console.log(`  NOTE: no ${fuel} on hand — module should fail cleanly.`);

  const result = await runModuleTest(bot, smeltModule, { input, fuel, quantity }, 180000);

  const inAfter = countItem(bot, input);
  const outAfter = countItem(bot, output);

  console.log('\n--- Smelting Result ---');
  console.log(`  Success(reported): ${result.success}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  ${input}: ${inBefore} -> ${inAfter}  |  ${output}: ${outBefore} -> ${outAfter} (ACTUALLY +${outAfter - outBefore})`);
  console.log(`  Data:`, result.data);

  const pass = (outAfter - outBefore) >= quantity;
  console.log(`  PASS (real ${output} +${quantity}): ${pass ? 'YES' : 'NO'}`);
  return pass;
}

// Try each log species that exists nearby until one actually YIELDS logs
// (handles spawns where the nearest tree of a given type is buried/unreachable).
async function gatherAnyLog(bot: Bot, gather: GatheringModule, qty: number): Promise<{ logType: string; count: number } | null> {
  const mcData = require('minecraft-data')(bot.version);
  const logTypes = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
  for (const lt of logTypes) {
    const bd = mcData.blocksByName[lt];
    if (!bd || !bot.findBlock({ matching: bd.id, maxDistance: 80 })) continue;
    const before = countItem(bot, lt);
    await runModuleTest(bot, gather, { targetType: 'block', target: lt, quantity: qty, searchRadius: 80 }, 150000);
    const got = countItem(bot, lt) - before;
    if (got > 0) return { logType: lt, count: got };
    console.log(`  ${lt}: present but unreachable, trying next species...`);
  }
  return null;
}

async function testLoop(bot: Bot, gather: GatheringModule, craft: CraftingModule): Promise<boolean> {
  console.log('\n========== TEST: Resource loop (gather -> craft chain) ==========');
  const wood = await gatherAnyLog(bot, gather, 5);
  if (!wood) { console.log('  SKIP: no reachable trees near spawn.'); return false; }
  const logType = wood.logType;
  console.log(`  Gathered ${wood.count}x ${logType}`);
  const plankType = logType.replace('_log', '_planks');
  const pBefore = countItem(bot, plankType);
  await runModuleTest(bot, craft, { item: plankType, quantity: 12 }, 60000);
  const planks = countItem(bot, plankType) - pBefore;
  console.log(`  Planks crafted (no-table): ${planks}`);

  const sBefore = countItem(bot, 'stick');
  await runModuleTest(bot, craft, { item: 'stick', quantity: 4 }, 45000);
  const sticks = countItem(bot, 'stick') - sBefore;
  console.log(`  Sticks crafted (no-table): ${sticks}`);

  const tBefore = countItem(bot, 'crafting_table');
  await runModuleTest(bot, craft, { item: 'crafting_table', quantity: 1 }, 45000);
  const tables = countItem(bot, 'crafting_table') - tBefore;
  console.log(`  Crafting tables crafted (no-table): ${tables}`);

  const wpBefore = countItem(bot, 'wooden_pickaxe');
  await runModuleTest(bot, craft, { item: 'wooden_pickaxe', quantity: 1 }, 60000);
  const picks = countItem(bot, 'wooden_pickaxe') - wpBefore;
  console.log(`  Wooden pickaxe crafted (NEEDS TABLE): ${picks}`);

  const pass = planks >= 4 && sticks >= 1 && picks >= 1;
  console.log(`  PASS (planks>=4 & sticks>=1 & pickaxe>=1): ${pass ? 'YES' : 'NO'}`);
  return pass;
}

async function testSmeltChain(
  bot: Bot, gather: GatheringModule, craft: CraftingModule, smelt: SmeltingModule,
): Promise<boolean> {
  console.log('\n========== TEST: Full slice (wood -> pickaxe -> cobble -> furnace -> smelt) ==========');
  const wood = await gatherAnyLog(bot, gather, 6);
  if (!wood) { console.log('  SKIP: no reachable trees near spawn.'); return false; }
  const logType = wood.logType;
  const plankType = logType.replace('_log', '_planks');
  console.log(`  Gathered ${wood.count}x ${logType}`);
  await runModuleTest(bot, craft, { item: plankType, quantity: 16 }, 60000);
  await runModuleTest(bot, craft, { item: 'stick', quantity: 4 }, 45000);
  await runModuleTest(bot, craft, { item: 'crafting_table', quantity: 1 }, 45000);
  await runModuleTest(bot, craft, { item: 'wooden_pickaxe', quantity: 1 }, 60000);
  console.log(`  planks=${countItem(bot, plankType)} sticks=${countItem(bot, 'stick')} pickaxe=${countItem(bot, 'wooden_pickaxe')}`);
  if (countItem(bot, 'wooden_pickaxe') < 1) { console.log('  FAIL: no pickaxe, cannot mine stone'); return false; }

  // Mine cobblestone (needs the pickaxe; gathering auto-equips it).
  await runModuleTest(bot, gather, { targetType: 'block', target: 'stone', quantity: 12, searchRadius: 64 }, 240000);
  const cobble = countItem(bot, 'cobblestone');
  console.log(`  cobblestone=${cobble}`);
  if (cobble < 8) { console.log('  FAIL: not enough cobblestone for a furnace'); return false; }

  await runModuleTest(bot, craft, { item: 'furnace', quantity: 1 }, 60000);
  console.log(`  furnace(item)=${countItem(bot, 'furnace')}`);

  // Smelt cobblestone -> stone using planks as fuel.
  const stoneBefore = countItem(bot, 'stone');
  await runModuleTest(bot, smelt, { input: 'cobblestone', fuel: plankType, quantity: 3 }, 180000);
  const stoneMade = countItem(bot, 'stone') - stoneBefore;
  console.log(`  stone smelted: ${stoneMade}`);

  const pass = stoneMade >= 1;
  console.log(`  PASS (smelted stone >= 1): ${pass ? 'YES' : 'NO'}`);
  return pass;
}

// --- Main ---

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBot(): Bot {
  const botOptions: any = {
    host: MC_HOST,
    port: MC_PORT,
    username: MC_AUTH === 'microsoft' ? MC_USERNAME : AGENT_ID,
    version: MC_VERSION,
    checkTimeoutInterval: 60 * 1000,
  };
  if (MC_AUTH === 'microsoft') botOptions.auth = 'microsoft';

  const bot = mineflayer.createBot(botOptions);

  // Resource-pack handshake (servers that force a pack hold us in configuration).
  const client: any = bot._client;
  const ack = (uuid?: string) => {
    try {
      const base = uuid !== undefined ? { uuid } : {};
      client.write('resource_pack_receive', { ...base, result: 3 });
      client.write('resource_pack_receive', { ...base, result: 0 });
    } catch (err) { logger.warn('resource pack ack failed:', err); }
  };
  client.on('add_resource_pack', (d: any) => { logger.info('Accepting resource pack (configuration)'); ack(d?.uuid); });
  client.on('resource_pack_send', (d: any) => { logger.info('Accepting resource pack (play)'); ack(d?.uuid); });
  return bot;
}

// Connect with retries — aternos intermittently resets the first connection(s).
async function connectWithRetry(attempts: number): Promise<Bot> {
  for (let i = 1; i <= attempts; i++) {
    logger.info(`Connecting to ${MC_HOST}:${MC_PORT} (v${MC_VERSION}, auth=${MC_AUTH}) — attempt ${i}/${attempts}`);
    const bot = buildBot();
    bot.on('error', () => {}); // swallow so a discarded bot's errors never go unhandled
    const ok = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
      bot.once('spawn', () => finish(true));
      bot.once('end', () => finish(false));
      bot.once('kicked', (r: any) => { logger.warn(`attempt ${i} kicked: ${JSON.stringify(r).slice(0, 120)}`); finish(false); });
      bot._client.once('error', (e: Error) => { logger.warn(`attempt ${i} error: ${e.message}`); finish(false); });
      setTimeout(() => finish(false), 40000);
    });
    if (ok) return bot;
    try { bot.end(); } catch {}
    if (i < attempts) await sleepMs(5000);
  }
  throw new Error(`Failed to connect after ${attempts} attempts`);
}

async function main(): Promise<void> {
  const bot = await connectWithRetry(5);
  let testFinished = false;
  logger.info(`Bot spawned at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);

  bot.on('error', (err: Error) => { logger.error('Bot error:', err.message); });
  bot.on('kicked', (reason: string) => { logger.error('Bot kicked:', reason); });
  bot.on('death', () => {
    logger.warn('Bot died! Auto-respawning...');
    setTimeout(() => { try { (bot as any).respawn?.(); } catch (e) {} }, 1000);
  });
  bot.on('end', (reason: string) => {
    if (testFinished) return; // expected disconnect after the test completed
    logger.error('Bot connection ended:', reason);
    process.exit(1);
  });

  // Load plugins the modules depend on (mirror production).
  try {
    const toolPlugin = require('mineflayer-tool').plugin;
    bot.loadPlugin(toolPlugin);
  } catch (err) {
    logger.warn('mineflayer-tool plugin not loaded (gathering may not auto-equip tools)');
  }
  try {
    const autoEat = require('@nxg-org/mineflayer-auto-eat');
    const p = typeof autoEat === 'function' ? autoEat : (autoEat.default || autoEat.plugin);
    if (p) bot.loadPlugin(p);
  } catch (err) {
    logger.warn('auto-eat plugin not loaded');
  }
  try {
    const combat = require('@nxg-org/mineflayer-custom-pvp');
    const p = typeof combat === 'function' ? combat : (combat.default || combat.plugin);
    if (p) bot.loadPlugin(p);
  } catch (err) {
    logger.warn('combat (swordpvp) plugin not loaded — bot will use basic attacks');
  }

  // Wait for chunks to load
  logger.info('Waiting 3s for chunks to load...');
  await sleepMs(3000);

    // Create module context
    const ctx: ModuleContext = { bot, reportEvent };

    // Initialize modules
    const navModule = new NavigationModule(ctx);
    navModule.initialize();

    const exploreModule = new ExplorationModule(ctx);
    exploreModule.initialize(navModule);

    const gatherModule = new GatheringModule(ctx);
    gatherModule.initialize(navModule, exploreModule);

    const craftModule = new CraftingModule(ctx);
    craftModule.initialize(navModule);

    const smeltModule = new SmeltingModule(ctx);
    smeltModule.initialize(navModule);

    // Start the survival/combat behavior layer so the bot defends itself (mobs
    // otherwise kill the defenseless bot and it loses everything).
    behaviorLayer = new BehaviorLayer(bot, AGENT_ID);
    behaviorLayer.start();

    // Recover from a hostile spawn (water -> swim to land; tree canopy -> mine down).
    await navModule.recoverToSafeGround();

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
        case 'smelt':
          pass = await testSmelting(bot, smeltModule);
          break;
        case 'loop':
          pass = await testLoop(bot, gatherModule, craftModule);
          break;
        case 'smeltchain':
          pass = await testSmeltChain(bot, gatherModule, craftModule, smeltModule);
          break;
      }
    } catch (err: any) {
      logger.error('Test threw:', err.message, err.stack);
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Test "${TEST_NAME}": ${pass ? 'PASSED' : 'FAILED'}`);
    console.log(`${'='.repeat(40)}\n`);

  testFinished = true;
  bot.quit();
  setTimeout(() => process.exit(pass ? 0 : 1), 1000);
}

main().catch((err) => {
  logger.error('Fatal:', err);
  process.exit(1);
});
