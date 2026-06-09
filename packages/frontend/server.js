const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// --- Configuration ---
const PORT = process.env.FRONTEND_PORT || 8080;
// Upstream coordinator WS address. Prefer COORDINATOR_WS_ADDRESS; fall back to
// the legacy ORCHESTRATOR_WS_ADDRESS for back-compat with older deployments.
const COORDINATOR_WS_ADDRESS =
    process.env.COORDINATOR_WS_ADDRESS ||
    process.env.ORCHESTRATOR_WS_ADDRESS ||
    'ws://localhost:5001'; // Default Coordinator WS port

// Browser → coordinator forwardable message types. Anything not on this
// allowlist is dropped (this stays a thin, well-scoped relay).
const FORWARDABLE_TYPES = new Set([
    'frontend::chat',
    'frontend::startGoal',
    'frontend::updateWhitelist',
    'frontend::getState',
]);

console.log(`--- Frontend Service ---`);
console.log(`HTTP Port: ${PORT}`);
console.log(`Coordinator WS Address: ${COORDINATOR_WS_ADDRESS}`);

// --- Express App Setup ---
const app = express();
const server = http.createServer(app);

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Basic route for the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WebSocket Client (Connects to Coordinator) ---
let coordinatorSocket = null;
let frontendWsServer = null; // WebSocket server for browser clients

// Send a frontend::getState request upstream to fetch the current snapshot.
function requestState() {
    if (coordinatorSocket && coordinatorSocket.readyState === WebSocket.OPEN) {
        coordinatorSocket.send(JSON.stringify({ type: 'frontend::getState', payload: {} }));
    }
}

function connectToCoordinator() {
    console.log(`Connecting to Coordinator at ${COORDINATOR_WS_ADDRESS}...`);
    coordinatorSocket = new WebSocket(COORDINATOR_WS_ADDRESS);

    coordinatorSocket.on('open', () => {
        console.log('Connected to Coordinator.');
        // Register frontend with Coordinator so it receives broadcasts.
        const registrationMessage = { type: 'frontend::register', senderId: 'frontend-ui', payload: {} };
        coordinatorSocket.send(JSON.stringify(registrationMessage));
        // Request an initial state snapshot.
        requestState();
    });

    coordinatorSocket.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('Message from Coordinator:', message.type);
            // Forward ALL coordinator messages to connected browser clients
            // (coordinator::chat, coordinator::state, etc.).
            broadcastToBrowsers(message);
        } catch (error) {
            console.error('Failed to parse message from Coordinator:', error);
        }
    });

    coordinatorSocket.on('close', () => {
        console.warn('Disconnected from Coordinator. Attempting reconnect...');
        coordinatorSocket = null;
        setTimeout(connectToCoordinator, 5000); // Reconnect after 5 seconds
    });

    coordinatorSocket.on('error', (error) => {
        console.error('Coordinator WebSocket error:', error.message);
        // Reconnect logic is handled by 'close' event
    });
}

// --- WebSocket Server (for Browser Clients) ---
function setupBrowserWebSocketServer() {
    frontendWsServer = new WebSocket.Server({ server }); // Attach WS server to the HTTP server
    console.log(`Frontend WebSocket server listening for browser connections.`);

    frontendWsServer.on('connection', (ws) => {
        console.log('Browser client connected.');

        // A new browser just connected — pull a fresh state snapshot from the
        // coordinator so this client renders current goals/agents/whitelist
        // quickly (the resulting coordinator::state is broadcast to all).
        requestState();

        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                console.log('Message from browser:', parsedMessage.type);

                // Relay allowlisted browser commands upstream to the coordinator.
                if (FORWARDABLE_TYPES.has(parsedMessage.type)) {
                    if (coordinatorSocket && coordinatorSocket.readyState === WebSocket.OPEN) {
                        console.log(`Forwarding ${parsedMessage.type} to Coordinator.`);
                        coordinatorSocket.send(JSON.stringify(parsedMessage));
                    } else {
                        console.warn(`Cannot forward ${parsedMessage.type}: Not connected to Coordinator.`);
                        ws.send(JSON.stringify({ type: 'error', payload: 'Not connected to Coordinator' }));
                    }
                } else {
                    console.warn(`Dropping non-forwardable browser message type: ${parsedMessage.type}`);
                }
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
    connectToCoordinator(); // Start connection attempt to Coordinator
});

// --- Graceful Shutdown ---
function shutdown() {
    console.log('Shutting down Frontend server...');
    if (frontendWsServer) {
        frontendWsServer.close(() => console.log('Browser WebSocket server closed.'));
    }
    if (coordinatorSocket) {
        coordinatorSocket.close(() => console.log('Coordinator WebSocket connection closed.'));
    }
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
