const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// --- Configuration ---
const PORT = process.env.FRONTEND_PORT || 8080;
const ORCHESTRATOR_WS_ADDRESS = process.env.ORCHESTRATOR_WS_ADDRESS || 'ws://localhost:5001'; // Default Orchestrator WS port

console.log(`--- Frontend Service ---`);
console.log(`HTTP Port: ${PORT}`);
console.log(`Orchestrator WS Address: ${ORCHESTRATOR_WS_ADDRESS}`);

// --- Express App Setup ---
const app = express();
const server = http.createServer(app);

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Basic route for the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WebSocket Client (Connects to Orchestrator) ---
let orchestratorSocket = null;
let frontendWsServer = null; // WebSocket server for browser clients

function connectToOrchestrator() {
    console.log(`Connecting to Orchestrator at ${ORCHESTRATOR_WS_ADDRESS}...`);
    orchestratorSocket = new WebSocket(ORCHESTRATOR_WS_ADDRESS);

    orchestratorSocket.on('open', () => {
        console.log('Connected to Orchestrator.');
        // Register frontend with Orchestrator (optional, depends on Orchestrator design)
        const registrationMessage = { type: 'frontend::register', senderId: 'frontend-ui', payload: {} };
        orchestratorSocket.send(JSON.stringify(registrationMessage));
    });

    orchestratorSocket.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('Message from Orchestrator:', message.type);
            // Forward relevant messages to connected browser clients
            broadcastToBrowsers(message);
        } catch (error) {
            console.error('Failed to parse message from Orchestrator:', error);
        }
    });

    orchestratorSocket.on('close', () => {
        console.warn('Disconnected from Orchestrator. Attempting reconnect...');
        orchestratorSocket = null;
        setTimeout(connectToOrchestrator, 5000); // Reconnect after 5 seconds
    });

    orchestratorSocket.on('error', (error) => {
        console.error('Orchestrator WebSocket error:', error.message);
        // Reconnect logic is handled by 'close' event
    });
}

// --- WebSocket Server (for Browser Clients) ---
function setupBrowserWebSocketServer() {
    frontendWsServer = new WebSocket.Server({ server }); // Attach WS server to the HTTP server
    console.log(`Frontend WebSocket server listening for browser connections.`);

    frontendWsServer.on('connection', (ws) => {
        console.log('Browser client connected.');

        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                console.log('Message from browser:', parsedMessage.type);

                // Handle commands from the browser UI (e.g., start goal)
                if (parsedMessage.type === 'frontend::startGoal') {
                    if (orchestratorSocket && orchestratorSocket.readyState === WebSocket.OPEN) {
                        console.log('Forwarding startGoal command to Orchestrator.');
                        orchestratorSocket.send(JSON.stringify(parsedMessage));
                    } else {
                        console.warn('Cannot forward startGoal: Not connected to Orchestrator.');
                        ws.send(JSON.stringify({ type: 'error', payload: 'Not connected to Orchestrator' }));
                    }
                }
                // Handle other commands if needed
            } catch (error) {
                console.error('Failed to parse message from browser:', error);
            }
        });

        ws.on('close', () => {
            console.log('Browser client disconnected.');
        });

        ws.on('error', (error) => {
            console.error('Browser WebSocket error:', error);
        });
    });
}

// Helper to broadcast messages to all connected browser clients
function broadcastToBrowsers(message) {
    if (!frontendWsServer) return;
    frontendWsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// --- Start Server and Connections ---
server.listen(PORT, () => {
    console.log(`Frontend HTTP server listening on port ${PORT}`);
    setupBrowserWebSocketServer();
    connectToOrchestrator(); // Start connection attempt to Orchestrator
});

// --- Graceful Shutdown ---
function shutdown() {
    console.log('Shutting down Frontend server...');
    if (frontendWsServer) {
        frontendWsServer.close(() => console.log('Browser WebSocket server closed.'));
    }
    if (orchestratorSocket) {
        orchestratorSocket.close(() => console.log('Orchestrator WebSocket connection closed.'));
    }
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);