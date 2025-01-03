// main.js
const { Worker } = require('worker_threads');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class BotManager {
    constructor() {
        this.bots = new Map();
        this.reservedStructures = new Map();
        this.setupServer();
    }

    setupServer() {
        // Express setup
        this.app = express();
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // HTTP server
        this.server = http.createServer(this.app);
        
        // WebSocket server
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws) => {
            console.log('Web client connected');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.broadcastToAllBots(data.command);
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            });
        });

        // Start server
        const PORT = 3000;
        this.server.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    }

    broadcast(data) {
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }

    handleReservation(position, botName) {
        const posKey = position.toString();
        if (this.reservedStructures.has(posKey)) {
            return false;
        }
        this.reservedStructures.set(posKey, botName);
        return true;
    }

    handleRelease(position) {
        const posKey = position.toString();
        this.reservedStructures.delete(posKey);
    }

    async start() {
        try {
            const accounts = fs.readFileSync('accs.txt', 'utf8')
                .trim()
                .split('\n')
                .map(line => {
                    const [username, password] = line.trim().split(':');
                    return { username, password };
                });

            for (const account of accounts) {
                await this.createBotWorker(account);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (error) {
            console.error('Error starting bot manager:', error);
        }
    }

    async createBotWorker(account) {
        try {
            const worker = new Worker('./botWorker.js', {
                workerData: {
                    username: account.username,
                    password: account.password,
                    serverHost: '159.54.167.2',
                    serverPort: 25567
                }
            });

            worker.on('message', (message) => {
                switch (message.type) {
                    case 'visualization':
                        this.broadcast(message.data);
                        break;
                    case 'status':
                        console.log(`[${account.username}] ${message.data}`);
                        break;
                    case 'reserveRequest':
                        const success = this.handleReservation(message.position, account.username);
                        worker.postMessage({ 
                            type: 'reserveResponse', 
                            position: message.position,
                            success 
                        });
                        break;
                    case 'release':
                        this.handleRelease(message.position);
                        break;
                }
            });

            worker.on('error', (error) => {
                console.error(`Error in bot ${account.username}:`, error);
            });

            worker.on('exit', (code) => {
                // Clean up any reservations for this bot
                for (const [pos, botName] of this.reservedStructures.entries()) {
                    if (botName === account.username) {
                        this.reservedStructures.delete(pos);
                    }
                }
                console.log(`Bot ${account.username} worker exited with code ${code}`);
                this.bots.delete(account.username);
            });

            this.bots.set(account.username, worker);
            console.log(`Created bot worker for ${account.username}`);
        } catch (error) {
            console.error(`Failed to create worker for ${account.username}:`, error);
        }
    }

    broadcastToAllBots(command) {
        for (const [_, worker] of this.bots) {
            worker.postMessage({ type: 'command', command });
        }
    }
}

// Start the bot manager
const manager = new BotManager();
manager.start().catch(console.error);