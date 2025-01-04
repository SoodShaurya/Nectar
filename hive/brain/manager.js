const EventEmitter = require("events");
const { groupmanager } = require("./groupmanager.js");
const { taskmanager, changetask } = require("./statemachine.js");

/**
 * @typedef {Object} managerEvents
 * @property {(cls: groupmanager, newState: typeof taskmanager) => void} stateEntered
 * @property {(cls: groupmanager, brainState: typeof taskmanager) => void} stateExited
 */

class manager extends EventEmitter {
  /**
   * @param {Bot[]} bots
   * @param {groupmanager} root
   */
  constructor(bots, root) {
    super();
    this.bots = bots;
    this.root = root;

    this.states = [];
    this.updates = [];
    this.nestedHives = [];
    this.activeBots = [];
    this.droppedBots = [];
    this.findStatesRecursive(this.root);
    this.findupdatesRecursive(this.root);
    this.findgroupmanagers(this.root);
    this.bots[0].on("physicsTick", this.update);
    this.root.active = true;
    this.root.onStateEntered();
  }

  /**
   * Removes bots from the hive mind.
   * @param {Bot[]} bots
   * @param {boolean} [override=false]
   */
  removeBots(bots, override = false) {
    for (const bot of bots) {
      const index = this.bots.indexOf(bot);
      if (index > -1) this.bots.splice(index, 1);

      for (const mind of this.nestedHives) {
        if (mind.autonomous && !override) continue;
        const mindIndex = mind.bots.indexOf(bot);
        if (mindIndex > -1) mind.bots.splice(mindIndex, 1);
      }

      if (!this.droppedBots.includes(bot)) this.droppedBots.push(bot);
    }
  }

  /**
   * Removes specific bots from a nested hive mind by name.
   * @param {string} hiveName
   * @param {...Bot} bots
   */
  removeBotsFrom(hiveName, ...bots) {
    for (const mind of this.nestedHives) {
      if (mind.constructor.name === hiveName) {
        for (const bot of bots) {
          const index = mind.bots.indexOf(bot);
          if (index > -1) mind.bots.splice(index, 1);
          if (!this.droppedBots.includes(bot)) this.droppedBots.push(bot);
        }
      }
    }
  }

  /**
   * Adds bots to the hive mind.
   * @param {...Bot} bots
   */
  addBots(...bots) {
    for (const bot of bots) {
      if (!this.bots.includes(bot)) this.bots.push(bot);

      for (const mind of this.nestedHives) {
        if (mind.autonomous) continue;
        if (!mind.bots.includes(bot)) mind.bots.push(bot);
      }

      const index = this.droppedBots.indexOf(bot);
      if (index > -1) this.droppedBots.splice(index, 1);
    }
  }

  /**
   * Adds specific bots to a nested hive mind by name.
   * @param {string} hiveName
   * @param {...Bot} bots
   */
  addBotsTo(hiveName, ...bots) {
    for (const mind of this.nestedHives) {
      if (mind.constructor.name === hiveName) {
        for (const bot of bots) {
          if (!mind.bots.includes(bot)) mind.bots.push(bot);

          const index = this.droppedBots.indexOf(bot);
          if (index > -1) this.droppedBots.splice(index, 1);
        }
      }
    }
  }

  /**
   * Recursively finds nested hive minds and registers them.
   * @param {groupmanager} nested
   * @param {number} [depth=0]
   */
  findgroupmanagers(nested, depth = 0) {
    this.nestedHives.push(nested);
    nested.depth = depth;

    nested.on("stateEntered", (state) => this.emit("stateEntered", nested, state));
    nested.on("stateExited", (state) => this.emit("stateExited", nested, state));
    nested.on("requestBots", this.provideBotsOnRequest);

    for (const state of nested.states) {
      if (state instanceof groupmanager) {
        this.findgroupmanagers(state, depth + 1);
      }
    }
  }

  /**
   * Recursively finds all states in the hive mind.
   * @param {groupmanager} nested
   */
  findStatesRecursive(nested) {
    for (const state of nested.states) {
      this.states.push(state);

      if (state instanceof groupmanager) {
        this.findStatesRecursive(state);
      }
    }
  }

  /**
   * Recursively finds all updates in the hive mind.
   * @param {groupmanager} nested
   */
  findupdatesRecursive(nested) {
    for (const trans of nested.updates) {
      this.updates.push(trans);
    }

    for (const state of nested.states) {
      if (state instanceof groupmanager) {
        this.findupdatesRecursive(state);
      }
    }
  }


  update = () => {
    this.root.update();

    for (const mind of this.nestedHives) {
      for (const stateName in mind.runningStates) {
        for (const state of mind.runningStates[stateName]) {
          if (!this.activeBots.includes(state.bot)) {
            this.activeBots.push(state.bot);
          }
        }
      }
    }
  };

  /**
   * @param {groupmanager} hivemind
   * @param {number} amount
   * @param {boolean} exclusive
   */
  provideBotsOnRequest = (hivemind, amount, exclusive) => {
    for (let i = 0; i < amount; i++) {
      const bot = this.bots[i];
      if (!bot) return;

      hivemind.bots.push(bot);
    }
  };
}

module.exports = { CentralHiveMind: manager };
