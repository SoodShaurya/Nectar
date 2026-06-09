import mineflayer, { Bot } from 'mineflayer';
import {
  createLogger,
  validateConfig,
  agentConfigSchema,
  createGracefulShutdown,
  metrics,
} from '@aetherius/shared-types';

import { BSMClient } from './bsm';
import { TaskManager } from './task-manager';
import { BehaviorLayer } from './behavior/layer';
import { createDefaultProfile } from './behavior/profile';
import { BehaviorAlert } from './behavior/alerts';

// Modules
import { NavigationModule } from './modules/navigation';
import { GatheringModule } from './modules/gathering';
import { CraftingModule } from './modules/crafting';
import { CombatModule } from './modules/combat';
import { ExplorationModule } from './modules/exploration';
import { SmeltingModule } from './modules/smelting';
import { BuildingModule } from './modules/building';
import { StorageModule } from './modules/storage';
import { TransferModule } from './modules/transfer';

// Services
import { InventoryManager } from './services/inventory-manager';
import { StructureDetector } from './services/structure-detector';
import { PerceptionService } from './services/perception';

const logger = createLogger('bot-agent');
const config = validateConfig(agentConfigSchema, 'Bot Agent');

const AGENT_ID = config.AGENT_ID || `agent-unknown-${Math.random().toString(36).substring(2, 8)}`;

logger.info('Starting Bot Agent', {
  agentId: AGENT_ID,
  bsmAddress: `${config.BSM_HOST}:${config.BSM_TCP_PORT}`,
  mcAddress: `${config.MC_HOST}:${config.MC_PORT}`,
});

// --- State ---
let bot: Bot | null = null;
let taskManager: TaskManager | null = null;
let behaviorLayer: BehaviorLayer | null = null;

// --- BSM Client ---
const bsm = new BSMClient(AGENT_ID, config.BSM_HOST, config.BSM_TCP_PORT, {
  authToken: config.CLUSTER_AUTH_TOKEN,
});

// --- Report helper for modules/services ---
function reportEvent(event: { eventType: string; taskId?: string; details?: any }): void {
  bsm.reportEvent(event as any);
}

// --- Bot Initialization ---
function initializeBot(): void {
  logger.info('Initializing Mineflayer bot');

  const botOptions: any = {
    host: config.MC_HOST,
    port: config.MC_PORT,
    username: config.MC_AUTH === 'microsoft' ? (config.MC_USERNAME ?? AGENT_ID) : AGENT_ID,
    version: config.MC_VERSION,
    checkTimeoutInterval: 60 * 1000,
    plugins: {
      combat: require('@nxg-org/mineflayer-custom-pvp'),
    },
  };

  if (config.MC_AUTH === 'microsoft') {
    botOptions.auth = 'microsoft';
    logger.info('Using Microsoft authentication', { username: botOptions.username });
  }

  bot = mineflayer.createBot(botOptions);

  // --- Resource-pack handshake ---
  // Servers that FORCE a resource pack hold the client in the configuration phase
  // until it acknowledges; without this the bot connects but never spawns.
  // mineflayer's bot.acceptResourcePack() mis-branches on newer protocols (e.g.
  // 1.21.11) and omits the required uuid, so respond to the raw packets directly.
  // We accept-without-downloading (ACCEPTED=3 then SUCCESSFULLY_LOADED=0).
  {
    const client: any = bot._client;
    const ackResourcePack = (uuid?: string) => {
      try {
        const base = uuid !== undefined ? { uuid } : {};
        client.write('resource_pack_receive', { ...base, result: 3 });
        client.write('resource_pack_receive', { ...base, result: 0 });
      } catch (err) {
        logger.warn('Failed to acknowledge resource pack:', err);
      }
    };
    // Configuration phase (1.20.3+): add_resource_pack carries the uuid.
    client.on('add_resource_pack', (data: any) => {
      logger.info('Resource pack requested (configuration); acknowledging', { forced: data?.forced });
      ackResourcePack(data?.uuid);
    });
    // Play phase / older servers: resource_pack_send.
    client.on('resource_pack_send', (data: any) => {
      logger.info('Resource pack requested (play); acknowledging');
      ackResourcePack(data?.uuid);
    });
  }

  // Load additional plugins after bot creation
  try {
    const autoEat = require('@nxg-org/mineflayer-auto-eat');
    if (typeof autoEat === 'function') bot.loadPlugin(autoEat);
    else if (autoEat.default) bot.loadPlugin(autoEat.default);
    else if (autoEat.plugin) bot.loadPlugin(autoEat.plugin);
  } catch (err) {
    logger.warn('Failed to load auto-eat plugin:', err);
  }

  try {
    const autoArmor = require('@nxg-org/mineflayer-auto-armor');
    if (typeof autoArmor === 'function') bot.loadPlugin(autoArmor);
    else if (autoArmor.default) bot.loadPlugin(autoArmor.default);
    else if (autoArmor.plugin) bot.loadPlugin(autoArmor.plugin);
  } catch (err) {
    logger.warn('Failed to load auto-armor plugin:', err);
  }

  try {
    const toolPlugin = require('mineflayer-tool').plugin;
    bot.loadPlugin(toolPlugin);
  } catch (err) {
    logger.warn('Failed to load mineflayer-tool plugin:', err);
  }

  // --- Bot Events ---
  bot.once('spawn', () => {
    logger.info(`Bot ${AGENT_ID} spawned`);
    metrics.increment('bot_spawns');

    // Pathfinder is loaded by NavigationModule.initialize()
    onBotSpawned().catch((err) => logger.error('onBotSpawned failed:', err));
  });

  bot.on('kicked', (reason: string) => {
    logger.error(`Bot kicked: ${reason}`);
    metrics.increment('bot_kicks');
  });

  bot.on('error', (err: Error) => {
    logger.error('Bot error:', err.message);
    metrics.increment('bot_errors');
  });

  bot.on('end', (reason: string) => {
    logger.info(`Bot disconnected: ${reason}`);
    metrics.increment('bot_disconnects');
  });

  bot.on('death', () => {
    logger.warn('Bot died');
    metrics.increment('bot_deaths');
    bsm.reportBehaviorAlert({
      agentId: AGENT_ID,
      type: 'agent_death',
      details: {
        deathPos: bot?.entity?.position ? {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        } : null,
        respawnPos: null,
      },
      activeModule: taskManager?.getCurrentTaskDescription() ?? null,
      moduleState: 'cancelled',
      timestamp: Date.now(),
    });
  });
}

async function onBotSpawned(): Promise<void> {
  if (!bot) return;

  const profile = createDefaultProfile();
  const moduleCtx = { bot, reportEvent };

  // --- Initialize Modules ---
  const navModule = new NavigationModule(moduleCtx);
  navModule.initialize();

  // Recover from a hostile spawn (in water -> swim to land; in a tree canopy ->
  // mine down) so the bot starts on safe ground.
  await navModule.recoverToSafeGround();

  // Exploration is created before gathering so gathering can relocate via it
  // when no target is reachable nearby.
  const exploreModule = new ExplorationModule(moduleCtx);
  exploreModule.initialize(navModule);

  const gatherModule = new GatheringModule(moduleCtx);
  gatherModule.initialize(navModule, exploreModule);

  const craftModule = new CraftingModule(moduleCtx);
  craftModule.initialize(navModule);

  const combatModule = new CombatModule(moduleCtx);
  combatModule.initialize(navModule);

  const smeltModule = new SmeltingModule(moduleCtx);
  smeltModule.initialize(navModule);

  const buildModule = new BuildingModule(moduleCtx);
  buildModule.initialize(navModule);

  const storageModule = new StorageModule(moduleCtx);
  storageModule.initialize(navModule);

  const transferModule = new TransferModule(moduleCtx);
  transferModule.initialize(navModule);

  // --- Background Services (created before TaskManager so structureDetector is available) ---
  const structureDetector = new StructureDetector(bot, AGENT_ID, reportEvent);
  structureDetector.start();

  const perception = new PerceptionService(bot, reportEvent);
  perception.start();

  const inventoryMgr = new InventoryManager(bot, profile);
  inventoryMgr.on('alert', (data) => {
    bsm.reportEvent({ eventType: 'behaviorAlert', details: { ...data, agentId: AGENT_ID, timestamp: Date.now() } });
  });
  inventoryMgr.start();

  // --- Task Manager ---
  taskManager = new TaskManager(bsm, bot, structureDetector);
  taskManager.registerModule(navModule);
  taskManager.registerModule(gatherModule);
  taskManager.registerModule(craftModule);
  taskManager.registerModule(combatModule);
  taskManager.registerModule(exploreModule);
  taskManager.registerModule(smeltModule);
  taskManager.registerModule(buildModule);
  taskManager.registerModule(storageModule);
  taskManager.registerModule(transferModule);

  // --- Behavior Layer ---
  behaviorLayer = new BehaviorLayer(bot, AGENT_ID, profile);
  behaviorLayer.on('alert', (alert: BehaviorAlert) => {
    bsm.reportBehaviorAlert(alert);
  });
  behaviorLayer.start();

  // --- Configure auto-eat from profile ---
  try {
    const autoEatOpts = (bot as any).autoEat;
    if (autoEatOpts) {
      autoEatOpts.options = {
        ...autoEatOpts.options,
        startAt: profile.hungerEatThreshold,
        priority: 'foodPoints',
      };
    }
  } catch (err) {
    logger.warn('Could not configure auto-eat:', err);
  }

  // --- Configure swordpvp for survivability ---
  // Defaults leave the bot too aggressive (it stays in the mob's hit arc and
  // never backs off after taking a hit), so it dies in melee. Tighten the
  // follow distance and lengthen the post-hit backoff. strafe/crit/onHit
  // configs default on; we leave them enabled and only adjust fields that exist.
  if ((bot as any).swordpvp) {
    try {
      const opts = (bot as any).swordpvp.options;
      if (opts) {
        if (opts.followConfig) {
          opts.followConfig.distance = 2; // keep just outside the mob's reach
        }
        if (opts.onHitConfig) {
          // Back off longer after taking a hit (default is short -> bot re-enters
          // the hit arc immediately and trades blows it loses).
          opts.onHitConfig.tickCount = 7;
        }
      }
    } catch (err) {
      logger.warn('Could not configure swordpvp:', err);
    }
  }

  // --- Status Reporting ---
  setInterval(() => {
    if (!bot?.entity || !bot.inventory) return;

    const keyInventory = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));

    bsm.reportStatusUpdate({
      agentId: AGENT_ID,
      timestamp: new Date().toISOString(),
      status: {
        health: bot.health,
        hunger: bot.food,
        saturation: bot.foodSaturation,
        position: {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z),
        },
        onGround: bot.entity.onGround,
        currentTaskDescription: taskManager?.getCurrentTaskDescription(),
        keyInventory,
      },
      destination: 'commander',
    } as any);
  }, 5000);

  // --- Player Chat Listener ---
  const botRef = bot; // Capture non-null reference for closure
  botRef.on('chat', (username: string, message: string) => {
    if (username === botRef.username) return; // Ignore self
    bsm.reportEvent({
      eventType: 'playerChat',
      details: { playerName: username, message },
    });
  });

  logger.info('All modules, services, and behavior layer initialized');
}

// --- Wire BSM Events ---
bsm.on('registered', () => {
  if (!bot) {
    initializeBot();
  }
});

bsm.on('command', (taskId: string, task: any, completionCondition?: any) => {
  if (!taskManager) {
    // Not yet initialized (bot still spawning) — reject so the coordinator replans.
    bsm.sendCommandAck(taskId, false, 'Agent not ready');
    return;
  }
  // Acknowledge immediately (design [A] step 3) based on the TaskManager's
  // synchronous acceptance decision, BEFORE the task executes.
  const result = taskManager.handleCommand(taskId, task, completionCondition);
  bsm.sendCommandAck(taskId, result.accepted, result.reason);
  behaviorLayer?.setActiveModule(taskManager.getCurrentModule());
});

bsm.on('cancelTask', (taskId: string) => {
  if (taskManager) {
    taskManager.cancelCurrentTask(taskId);
    behaviorLayer?.setActiveModule(null);
  }
});

bsm.on('chatMessage', (message: string) => {
  // The coordinator routes replies to the web frontend only (not in-game), so
  // this rarely fires. Keep it defensive regardless: mineflayer's chat-send can
  // throw on some protocol versions (e.g. 1.21.11: "bot._client.chat is not a
  // function") and must NEVER take down the agent process.
  if (!bot) return;
  try {
    bot.chat(message);
  } catch (err) {
    logger.warn('In-game chat send failed (ignored):', err instanceof Error ? err.message : String(err));
  }
});

bsm.on('updateProfile', (profile: any) => {
  behaviorLayer?.updateProfile(profile);
  logger.info('Received profile update from coordinator');
});

// --- Start ---
bsm.connect();

// --- Graceful Shutdown ---
const shutdown = createGracefulShutdown(logger);

shutdown.register(async () => {
  behaviorLayer?.stop();
});

shutdown.register(async () => {
  bsm.destroy();
});

shutdown.register(async () => {
  if (bot) {
    bot.quit('Agent shutting down');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
});
