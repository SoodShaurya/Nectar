const { EventEmitter } = require("events");
const { taskmanager, changetask } = require("./statemachine.js");

class groupmanager extends EventEmitter {
    constructor({ 
        stateName: name, 
        bots, 
        updates, 
        enter, 
        exit = undefined, 
        data = {}, 
        autonomous = false, 
        ignoreBusy = false 
    }) {
        super();
        this.stateName = name;
        this.autonomous = autonomous;
        this.ignoreBusy = ignoreBusy;
        this.bots = bots;
        this.updates = updates;
        this.enter = enter;
        this.exit = exit;
        this.data = data;
        this.runningStates = {};
        this.states = this.findStates();
        this.depth = 0;
        this.active = false;
        this.recognizeStates();
    }

    recognizeStates() {
        for (const state of this.states) {
            if (state && state.stateName) {
                this.runningStates[state.stateName] = this.runningStates[state.stateName] || [];
            }
        }
    }    

    findStates() {
        const states = [];
        states.push(this.enter);

        if (this.exit != null && !states.includes(this.exit)) {
            states.push(this.exit);
        }

        for (const trans of this.updates) {
            if (!states.includes(trans.parentState)) {
                states.push(trans.parentState);
            }
            if (!states.includes(trans.childState)) {
                states.push(trans.childState);
            }
        }
        return states;
    }

    getUsableBots() {
        const usable = [];
        for (const bot of this.bots) {
            const info = Object.entries(this.runningStates).find(([name, botList]) => 
                botList.find(b => b.bot === bot)
            );
            
            if (this.ignoreBusy && info) continue;
            
            if (!this.ignoreBusy && info) {
                const state = this.runningStates[info[0]].find(stateType => stateType.bot === bot);
                const staticRef = this.states.find(state => this.runningStates[info[0]][0] instanceof state);
                
                if (staticRef.autonomous) continue;
                
                this.removeState(info[0], state);
                state.active = false;
                state.onStateExited?.();
            }
            usable.push(bot);
        }
        return usable;
    }

    removeState(stateName, state, index) {
        index = index ?? this.runningStates[stateName].indexOf(state);
        if (index > -1) this.runningStates[stateName].splice(index, 1);
    }

    pushState(stateName, state) {
        // Initialize the array if it doesn't exist
        if (!this.runningStates[stateName]) {
            this.runningStates[stateName] = [];
        }
        
        if (!this.runningStates[stateName].includes(state)) {
            this.runningStates[stateName].push(state);
        }
    }
    

    onStateEntered() {
        this.activeStateType = this.enter;
        const bots = this.getUsableBots();
        this.enterStates(this.activeStateType, ...bots);
    }

    setStatesInactive(stateType) {
  
        if (this.runningStates[stateType.stateName] && 
            Array.isArray(this.runningStates[stateType.stateName])) {
            for (const state of this.runningStates[stateType.stateName]) {
                state.active = false;
            }
        }
    }
    

    enterStates(enterState, ...bots) {
        for (const bot of bots) {
            const state = new enterState(bot, this.data);
            state.active = true;
            this.runningStates[enterState.stateName].push(state); 
            state.onStateEntered?.();
        }
        this.emit("stateEntered", enterState);
    }

    exitStates(exitState) {
        const states = this.runningStates[exitState.stateName];
        for (const state of states) {
            state.active = false;
            state.onStateExited?.();
        }
        this.runningStates[exitState.stateName] = [];
        this.emit("stateExited", exitState);
    }
    
    x

    updateStates() {
        if (!this.activeStateType) return;
        const states = this.runningStates[this.activeStateType.stateName];
        if (!states || !Array.isArray(states)) return;
        
        for (const state of states) {
            state.update?.();
        }
    }
    

    update() {
        this.updateStates();
        this.monitorAutonomous();

        for (const transition of this.updates) {
            if (transition.parentState === this.activeStateType) {
                if (transition.isTriggered() || transition.shouldChange()) {
                    transition.resetTrigger();
                    if (transition.parentState.autonomous) {
                        transition.onTransition();
                        this.activeStateType = transition.childState;
                    } else {
                        this.setStatesInactive(transition.parentState);
                        this.exitStates(transition.parentState);
                        transition.onTransition();
                        const bots = this.getUsableBots();
                        this.activeStateType = transition.childState;
                        this.enterStates(this.activeStateType, ...bots);
                    }
                    return;
                }
            }
        }
    }

    monitorAutonomous() {
        for (const stateName in this.runningStates) {
            const staticRef = this.states.find(state => 
                this.runningStates[stateName][0] instanceof state
            );
            
            for (const state of this.runningStates[stateName]) {
                if (staticRef.autonomous && state.exitCase?.()) {
                    state.active = false;
                    state.onStateExited?.();
                    const index = this.runningStates[stateName].indexOf(state);
                    
                    if (index > -1) {
                        const bot = this.runningStates[stateName][index].bot;
                        this.removeState(stateName, state, index);

                        if (this.activeStateType) {
                            const newState = new this.activeStateType(bot, this.data);
                            newState.active = true;
                            newState.onStateEntered?.();
                            this.pushState(this.activeStateType.name, newState);
                        }
                    }
                }
            }
        }
    }

    onStateExited() {
        if (this.activeStateType == null) return;
        this.exitStates(this.activeStateType);
        this.activeStateType = undefined;
    }

    isFinished() {
        if (this.active == null) return true;
        if (this.exit == null) return false;
        return this.activeStateType === this.exit;
    }

    requestBots(amount = 1, exclusive = false) {
        this.emit("requestBots", this, amount, exclusive);
    }
}

module.exports = { groupmanager };
