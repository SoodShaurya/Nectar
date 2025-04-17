const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const botManager = require('./botManager'); // We'll create this next

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

// --- WebSocket Server ---
const wss = new WebSocket.Server({ server });

console.log(`WebSocket server started on port ${PORT}`);

// Function to broadcast messages to all connected clients
const broadcast = (data) => {
    const messageString = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
};

// Initialize Bot Manager with broadcast function
botManager.init(broadcast);

wss.on('connection', (ws) => {
    console.log('Client connected');

    // Send initial state
    ws.send(JSON.stringify({ type: 'botListUpdate', payload: botManager.getBotList() }));
    ws.send(JSON.stringify({ type: 'availableActivities', payload: botManager.getAvailableActivities() }));


    ws.on('message', (message) => {
        console.log('Received:', message.toString());
        try {
            const parsedMessage = JSON.parse(message.toString());
            const { type, payload } = parsedMessage;

            switch (type) {
                case 'createBot':
                    botManager.createBot(payload); // botManager will handle broadcasting updates
                    break;
                case 'deleteBot':
                    botManager.deleteBot(payload.botId); // botManager will handle broadcasting updates
                    break;
                case 'changeActivity':
                    botManager.changeActivity(payload.botId, payload.activityName); // botManager will handle broadcasting updates
                    break;
                case 'getBotList': // Explicit request (though we send on connect)
                     ws.send(JSON.stringify({ type: 'botListUpdate', payload: botManager.getBotList() }));
                     break;
                case 'getActivities': // Explicit request (though we send on connect)
                     ws.send(JSON.stringify({ type: 'availableActivities', payload: botManager.getAvailableActivities() }));
                     break;
                default:
                    console.log('Unknown message type:', type);
                    ws.send(JSON.stringify({ type: 'error', payload: `Unknown message type: ${type}` }));
            }
        } catch (error) {
            console.error('Failed to parse message or handle request:', error);
            ws.send(JSON.stringify({ type: 'error', payload: 'Invalid message format or server error.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

server.listen(PORT, () => {
    console.log(`HTTP server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    botManager.shutdownAllBots(); // Implement this in botManager
    wss.close(() => {
        server.close(() => {
            console.log('Server shut down.');
            process.exit(0);
        });
    });
});
