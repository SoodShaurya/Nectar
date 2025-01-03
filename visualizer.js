// visualizer.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

function broadcastBotData(botData) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(botData));
        }
    });
}

server.listen(3000, () => {
    console.log('Visualization server running on http://localhost:3000');
});

module.exports = { broadcastBotData };