const { EventEmitter } = require('events');
const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');

class StateMachine extends EventEmitter {
    constructor(bot) {
        super();
        this.bot = bot;
        this.currentState = null;
        this.states = new Map();
        this.tasks = new Map();
        this.stateQueue = [];
        this.isExecuting = false;
        this.loadtasks();
    }

    loadtasks() {
        const tasksPath = path.join(__dirname, 'tasks');
        
        try {
            const files = fs.readdirSync(tasksPath);
            for (const file of files) {
                if (file.endsWith('.js')) {
                    const taskName = path.basename(file, '.js');
                    const taskClass = require(path.join(tasksPath, file));
                    this.tasks.set(taskName, new taskClass(this.bot));
                }
            }
        } catch (error) {
            this.handleError('Failed to load tasks: ' + error.message);
        }
    }

    registerState(name, tasks, transitions) {
        this.states.set(name, {
            name,
            tasks: tasks.map(task => {
                const taskInstance = this.tasks.get(task);
                if (!taskInstance) {
                    throw new Error(`task ${task} not found`);
                }
                return taskInstance;
            }),
            transitions,
            status: 'idle'
        });
    }

    async setState(stateName, data = {}) {
        const state = this.states.get(stateName);
        if (!state) {
            this.handleError(`State ${stateName} not found`);
            return;
        }

        this.stateQueue.push({ name: stateName, data });
        
        // Notify main thread about state change
        parentPort.postMessage({
            type: 'stateChange',
            state: stateName,
            data: data
        });

        if (!this.isExecuting) {
            this.executeNextState();
        }
    }

    async executeNextState() {
        if (this.stateQueue.length === 0) {
            this.isExecuting = false;
            return;
        }

        this.isExecuting = true;
        const { name, data } = this.stateQueue.shift();
        const state = this.states.get(name);

        try {
            // Stop current state tasks if any
            if (this.currentState) {
                await this.stopCurrentState();
            }

            this.currentState = state;
            state.status = 'running';

            // Notify main thread about state execution
            parentPort.postMessage({
                type: 'stateExecuting',
                state: name,
                data: data
            });

            // Execute all tasks in the state
            for (const task of state.tasks) {
                await task.start(data);
            }

            // Check for transitions
            this.checkTransitions(state, data);

        } catch (error) {
            this.handleError(`Error executing state ${name}: ${error.message}`);
        }
    }

    async stopCurrentState() {
        if (!this.currentState) return;

        try {
            for (const task of this.currentState.tasks) {
                await task.stop();
            }
            this.currentState.status = 'idle';
        } catch (error) {
            this.handleError(`Error stopping state ${this.currentState.name}: ${error.message}`);
        }
    }

    checkTransitions(state, data) {
        if (!state.transitions) return;

        for (const transition of state.transitions) {
            if (transition.condition(this.bot, data)) {
                this.setState(transition.nextState, data);
                break;
            }
        }
    }

    handleError(error) {
        parentPort.postMessage({
            type: 'stateError',
            error: error
        });
    }

    // Handle messages from main thread
    handleMessage(message) {
        switch (message.type) {
            case 'setState':
                this.setState(message.state, message.data);
                break;
            case 'stopState':
                this.stopCurrentState();
                break;
            case 'getState':
                parentPort.postMessage({
                    type: 'currentState',
                    state: this.currentState ? this.currentState.name : null,
                    status: this.currentState ? this.currentState.status : 'idle'
                });
                break;
        }
    }
}

// Example task base class
class task {
    constructor(bot) {
        this.bot = bot;
        this.isRunning = false;
    }

    async start(data) {
        this.isRunning = true;
        // Implementation in derived classes
    }

    async stop() {
        this.isRunning = false;
        // Implementation in derived classes
    }

    async update() {
        // Implementation in derived classes
    }
}

module.exports = { StateMachine, task };
