// visualizerServer.js
const { parentPort } = require('worker_threads');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

class VisualizerServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });

        // Serve static files from public directory
        this.app.use(express.static(path.join(__dirname, 'public')));

        this.setupWebSocket();
        this.startServer();
    }

    startServer() {
        const PORT = 3000;
        this.server.listen(PORT, () => {
            console.log(`Visualizer server running on http://localhost:${PORT}`);
        });
    }

    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            console.log('New client connected');

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    parentPort.postMessage({
                        type: 'command',
                        command: data.command
                    });
                } catch (error) {
                    console.error('Error processing websocket message:', error);
                }
            });

            ws.on('close', () => {
                console.log('Client disconnected');
            });
        });
    }

    broadcast(data) {
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
}

const server = new VisualizerServer();

parentPort.on('message', (message) => {
    if (message.type === 'botUpdate') {
        server.broadcast(message.data);
    }
});