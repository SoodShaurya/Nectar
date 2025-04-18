const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require("socket.io"); // Use Socket.IO
const botManager = require('./botManager');

const PORT = process.env.PORT || 6900;

// --- HTTP Server ---
const server = http.createServer((req, res) => {
    // Serve frontend files
    let filePath = path.join(__dirname, '../frontend', req.url === '/' ? 'index.html' : req.url);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        // Add other mime types if needed
    };
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                // File not found, try index.html for directories
                if (req.url.endsWith('/')) {
                    filePath = path.join(__dirname, '../frontend', req.url, 'index.html');
                    fs.readFile(filePath, (error2, content2) => {
                         if (error2) {
                             res.writeHead(404, { 'Content-Type': 'text/html' });
                             res.end('404 Not Found', 'utf-8');
                         } else {
                             res.writeHead(200, { 'Content-Type': 'text/html' });
                             res.end(content2, 'utf-8');
                         }
                    });
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.end('404 Not Found', 'utf-8');
                }
            } else {
                // Server error
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            // Success
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// --- Socket.IO Server ---
const io = new Server(server, {
    cors: {
      origin: "http://localhost:3000", // Allow frontend origin (adjust if different)
      methods: ["GET", "POST"]
    }
});

console.log(`Socket.IO server started on port ${PORT} with CORS enabled for http://localhost:3000`);

// Function to broadcast messages to all connected clients in the default namespace
const broadcast = (data) => {
    io.emit(data.type, data.payload); // Emit with type as event name, payload as data
};

// Initialize Bot Manager with broadcast function
botManager.init(broadcast);

// --- Default Namespace Logic (for manager UI) ---
io.on('connection', (socket) => {
    console.log('Manager client connected:', socket.id);

    // Send initial state
    socket.emit('botListUpdate', botManager.getBotList());
    socket.emit('availableActivities', botManager.getAvailableActivities());

    // Listen for commands from the manager frontend
    socket.on('createBot', (payload) => {
        console.log('Received createBot:', payload);
        botManager.createBot(payload); // botManager will handle broadcasting updates via broadcast()
    });

    socket.on('deleteBot', (payload) => {
        console.log('Received deleteBot:', payload);
        if (payload && payload.botId) {
            botManager.deleteBot(payload.botId); // botManager will handle broadcasting updates
        } else {
             console.error('Invalid deleteBot payload:', payload);
             socket.emit('error', 'Invalid deleteBot payload');
        }
    });

    socket.on('changeActivity', (payload) => {
        console.log('Received changeActivity:', payload);
         if (payload && payload.botId && payload.activityName) {
            botManager.changeActivity(payload.botId, payload.activityName); // botManager will handle broadcasting updates
         } else {
             console.error('Invalid changeActivity payload:', payload);
              socket.emit('error', 'Invalid changeActivity payload');
          }
     });

    socket.on('set_target_coords', (payload) => {
        console.log('Received set_target_coords:', payload);
        if (payload && payload.botId && payload.coords &&
            typeof payload.coords.x === 'number' &&
            typeof payload.coords.y === 'number' &&
            typeof payload.coords.z === 'number')
        {
            // We'll add this function to botManager next
            botManager.setBotTargetCoordinates(payload.botId, payload.coords);
        } else {
            console.error('Invalid set_target_coords payload:', payload);
            socket.emit('error', 'Invalid set_target_coords payload');
        }
    });

     socket.on('getBotList', () => { // Explicit request
          console.log('Received getBotList request');
         socket.emit('botListUpdate', botManager.getBotList());
    });

    socket.on('getActivities', () => { // Explicit request
         console.log('Received getActivities request');
         socket.emit('availableActivities', botManager.getAvailableActivities());
    });

    // --- New listeners for Combat Activity ---
    socket.on('startCombat', (payload) => {
        console.log('Received startCombat:', payload);
        if (payload && payload.botId && payload.targetId) {
            // Pass targetId in the options object
            botManager.changeActivity(payload.botId, 'combat', { targetId: payload.targetId });
        } else {
            console.error('Invalid startCombat payload:', payload);
            socket.emit('error', 'Invalid startCombat payload: requires botId and targetId');
        }
    });

    socket.on('stopCombat', (payload) => {
        console.log('Received stopCombat:', payload);
        if (payload && payload.botId) {
            // Change back to a default idle activity to trigger combat unload
            botManager.changeActivity(payload.botId, 'stand_still');
        } else {
            console.error('Invalid stopCombat payload:', payload);
            socket.emit('error', 'Invalid stopCombat payload: requires botId');
        }
    });

    socket.on('getNearbyEntities', (payload) => {
        console.log('Received getNearbyEntities:', payload);
        if (payload && payload.botId) {
            const entities = botManager.getNearbyEntities(payload.botId);
            // Emit back to the requesting client only
            socket.emit('nearbyEntitiesList', { botId: payload.botId, entities: entities });
        } else {
             console.error('Invalid getNearbyEntities payload:', payload);
              socket.emit('error', 'Invalid getNearbyEntities payload: requires botId');
         }
     });

    // Reverted: Shield is now default in combat activity
    socket.on('setCombatTarget', (payload) => {
        console.log('Received setCombatTarget:', payload);
        if (payload && payload.botId && payload.targetId !== undefined) { // Check targetId exists
            // 1. Set the target in memory
            botManager.setBotCombatTarget(payload.botId, payload.targetId);
            // 2. Change activity to combat (no options needed for shield)
            //    The combat activity will read targetId from memory and enable shield by default
            botManager.changeActivity(payload.botId, 'combat');
            // Optionally send confirmation back to client?
            // socket.emit('combatTargetSet', { botId: payload.botId, targetId: payload.targetId });
        } else {
            console.error('Invalid setCombatTarget payload:', payload);
            socket.emit('error', 'Invalid setCombatTarget payload: requires botId and targetId');
        }
    });

    socket.on('setGuardTarget', (payload) => {
        console.log('Received setGuardTarget:', payload);
        if (payload && payload.guardingBotId && payload.targetBotId) {
            // 1. Set the target in the guarding bot's memory
            botManager.setBotGuardTarget(payload.guardingBotId, payload.targetBotId);
            // 2. Change the guarding bot's activity to 'guard'
            //    The guard activity itself will read the target from memory
            botManager.changeActivity(payload.guardingBotId, 'guard');
            // Optionally send confirmation back
            // socket.emit('guardTargetSet', { guardingBotId: payload.guardingBotId, targetBotId: payload.targetBotId });
        } else {
            console.error('Invalid setGuardTarget payload:', payload);
            socket.emit('error', 'Invalid setGuardTarget payload: requires guardingBotId and targetBotId');
        }
    });
     // --- End of New Listeners ---


     socket.on('disconnect', () => {
        console.log('Manager client disconnected:', socket.id);
    });

    socket.on('error', (error) => {
        console.error('Socket.IO error (default namespace):', error);
    });
});


// --- Viewer Namespace Logic ---
const viewerNamespace = io.of('/viewer');
const botSockets = {}; // Store mapping from botId to socket id for viewer namespace { botId: socket.id }
const clientSubscriptions = {}; // Store mapping from client socket id to the botId they are viewing { socket.id: botId }

viewerNamespace.on('connection', (socket) => {
    console.log('Viewer client/bot connected:', socket.id);

    socket.on('identifyAsBot', ({ botId }) => {
        if (!botId) return;
        console.log(`Bot ${botId} identified with socket ${socket.id}`);
        botSockets[botId] = socket.id;
        // Optional: Join a room specific to the bot itself? Might not be needed.
        // socket.join(botId + '-bot');
    });

    socket.on('identifyAsClient', () => {
        console.log(`Viewer client identified with socket ${socket.id}`);
        // No specific action needed on identification, waits for subscription
    });

    socket.on('subscribeToBot', ({ botId }) => {
        if (!botId) return;
        console.log(`Client ${socket.id} subscribing to bot ${botId}`);
        // Leave previous room if any
        const previousBotId = clientSubscriptions[socket.id];
        if (previousBotId) {
            socket.leave(previousBotId);
            console.log(`Client ${socket.id} left room ${previousBotId}`);
        }
        // Join new room
        socket.join(botId);
        clientSubscriptions[socket.id] = botId;
        console.log(`Client ${socket.id} joined room ${botId}`);
        // Maybe send initial state if needed? Depends on frontend implementation.
    });

     socket.on('unsubscribeFromBot', ({ botId }) => {
        if (!botId) return;
        console.log(`Client ${socket.id} unsubscribing from bot ${botId}`);
        socket.leave(botId);
        if (clientSubscriptions[socket.id] === botId) {
            delete clientSubscriptions[socket.id];
        }
     });

    socket.on('viewerData', ({ botId, payload }) => {
        if (!botId || !payload) return;
        // console.log(`Received viewer data from bot ${botId}:`, payload.type); // DEBUG: Can be very noisy
        // Emit data only to clients subscribed to this specific bot
        viewerNamespace.to(botId).emit('viewerUpdate', payload);
    });

    socket.on('disconnect', () => {
        console.log('Viewer client/bot disconnected:', socket.id);
        // Check if it was a bot
        const disconnectedBotId = Object.keys(botSockets).find(key => botSockets[key] === socket.id);
        if (disconnectedBotId) {
            console.log(`Bot ${disconnectedBotId} disconnected from viewer namespace.`);
            delete botSockets[disconnectedBotId];
            // Optional: Notify subscribed clients that the bot disconnected?
            // viewerNamespace.to(disconnectedBotId).emit('botDisconnected', { botId: disconnectedBotId });
        }
        // Check if it was a client
        const viewedBotId = clientSubscriptions[socket.id];
        if (viewedBotId) {
            console.log(`Client ${socket.id} disconnected while viewing ${viewedBotId}.`);
            // No need to leave room, socket is gone. Just clean up our tracking.
            delete clientSubscriptions[socket.id];
        }
    });

     socket.on('error', (error) => {
        console.error('Socket.IO error (viewer namespace):', error);
    });
});


server.listen(PORT, () => {
    console.log(`HTTP server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    botManager.shutdownAllBots();
    io.close(() => { // Close Socket.IO server
        console.log('Socket.IO server closed.');
        server.close(() => {
            console.log('HTTP server shut down.');
            process.exit(0);
        });
    });
});
