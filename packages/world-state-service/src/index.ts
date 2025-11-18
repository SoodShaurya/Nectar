import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { WorldStateReportPayload, WebSocketMessage } from '@aetherius/shared-types';
import POI from './models/poi'; // Import the actual POI model
import ResourceNode from './models/resourceNode'; // Import the actual ResourceNode model
import Infrastructure from './models/infrastructure'; // Import the actual Infrastructure model

// --- Configuration (Replace with actual config loading) ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/aetherius_world_state';
const WS_PORT = parseInt(process.env.WS_PORT || '3001', 10);

const POI_DEDUPLICATION_RADIUS = 10; // meters
const RESOURCE_DEDUPLICATION_RADIUS = 5; // meters
const INFRA_DEDUPLICATION_RADIUS = 15; // meters

// --- Express App Setup ---
const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

// --- MongoDB Connection ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1); // Exit if DB connection fails
    });

// Mongoose models are now imported from the models/ directory

// --- API Endpoints ---

// POST /report - Accepts reports from BSMs (originating from Agents)
app.post('/report', async (req: Request, res: Response, next: NextFunction) => {
    const report = req.body as WorldStateReportPayload; // Add validation later

    console.log(`Received report: ${report.dataType} from ${report.reporterAgentId}`);

    try {
        // Basic deduplication/update logic needed here
        switch (report.dataType) {
            case 'poi':
                // Deduplication check for POI
                const existingPOI = await POI.findOne({
                    type: report.data.type,
                    coords: {
                        $nearSphere: {
                            $geometry: {
                                type: "Point",
                                coordinates: [report.data.coords.x, report.data.coords.z] // Use x, z for 2D check initially, or add y if needed and using 3D sphere
                            },
                            $maxDistance: POI_DEDUPLICATION_RADIUS
                        }
                    }
                });

                if (existingPOI) {
                    console.log(`Duplicate POI found nearby for type ${report.data.type} at ${JSON.stringify(report.data.coords)}. Skipping creation.`);
                    // TODO: Optionally update timestamp or details of existingPOI
                    // await POI.updateOne({ _id: existingPOI._id }, { $set: { timestamp: new Date() } });
                } else {
                    await POI.create(report.data);
                    console.log(`New POI data stored: ${report.data.type} at ${JSON.stringify(report.data.coords)}`);
                }
                break;
            case 'resourceNode':
                // Deduplication check for ResourceNode
                 const existingResource = await ResourceNode.findOne({
                    resourceType: report.data.resourceType,
                    depleted: false, // Only check against non-depleted nodes
                    coords: {
                        $nearSphere: {
                            $geometry: {
                                type: "Point",
                                coordinates: [report.data.coords.x, report.data.coords.z]
                            },
                            $maxDistance: RESOURCE_DEDUPLICATION_RADIUS
                        }
                    }
                });

                 if (existingResource) {
                    console.log(`Duplicate ResourceNode found nearby for type ${report.data.resourceType} at ${JSON.stringify(report.data.coords)}. Skipping creation.`);
                     // TODO: Optionally update timestamp or quantityEstimate
                } else {
                    await ResourceNode.create(report.data);
                    console.log(`New ResourceNode data stored: ${report.data.resourceType} at ${JSON.stringify(report.data.coords)}`);
                }
                break;
            case 'infrastructure':
                // TODO: Add similar deduplication logic for Infrastructure using INFRA_DEDUPLICATION_RADIUS
                await Infrastructure.create(report.data);
                console.log(`Infrastructure data stored: ${report.data.type} ${report.data.name}`);
                break;
            default:
                console.warn(`Received unknown report dataType: ${(report as any).dataType}`);
                return res.status(400).json({ message: 'Invalid report type' });
        }
        res.status(201).json({ message: 'Report received and processed' });
    } catch (error) {
        console.error('Error processing report:', error);
        next(error); // Pass error to error handling middleware
    }
});

// GET /query - Accepts queries from Orchestrator
app.get('/query', async (req: Request, res: Response, next: NextFunction) => {
    const { type } = req.query;
    let queryFilter = {};
    let queryLimit = 0; // Default to no limit

    console.log(`Received query: type=${type}, filter=${req.query.filter}, options=${req.query.options}`);

    // Safely parse filter
    if (req.query.filter && typeof req.query.filter === 'string') {
        try {
            queryFilter = JSON.parse(req.query.filter);
        } catch (e) {
            console.warn('Failed to parse query filter JSON:', e);
            return res.status(400).json({ message: 'Invalid filter JSON format' });
        }
    }

    // Safely parse options and extract limit
    if (req.query.options && typeof req.query.options === 'string') {
        try {
            const parsedOptions = JSON.parse(req.query.options);
            if (parsedOptions && typeof parsedOptions.limit === 'number' && parsedOptions.limit > 0) {
                queryLimit = Math.floor(parsedOptions.limit); // Ensure integer
            } else if (parsedOptions && typeof parsedOptions.limit === 'string') {
                 const parsedLimit = parseInt(parsedOptions.limit, 10);
                 if (!isNaN(parsedLimit) && parsedLimit > 0) {
                     queryLimit = parsedLimit;
                 }
            }
        } catch (e) {
            console.warn('Failed to parse query options JSON:', e);
            // Don't necessarily fail the request, just ignore options
        }
    }

    try {
        let results: any[] = [];
        let query;

        switch (type) {
            case 'poi':
                query = POI.find(queryFilter);
                if (queryLimit > 0) query = query.limit(queryLimit);
                results = await query.exec();
                break;
            case 'resourceNode':
                query = ResourceNode.find(queryFilter);
                 if (queryLimit > 0) query = query.limit(queryLimit);
                 results = await query.exec();
                break;
             case 'infrastructure':
                query = Infrastructure.find(queryFilter);
                 if (queryLimit > 0) query = query.limit(queryLimit);
                 results = await query.exec();
                break;
            // Add more query types as needed
            default:
                return res.status(400).json({ message: 'Invalid query type specified' });
        }
        console.log(`Query successful, returning ${results.length} results (Limit: ${queryLimit || 'None'}).`);
        res.status(200).json(results);
    } catch (error) {
        console.error('Error processing query:', error);
        next(error);
    }
});

// --- Basic Error Handling Middleware ---
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Unhandled error:", err.stack);
    res.status(500).json({ message: 'Internal Server Error' });
});

// --- HTTP Server ---
const server = http.createServer(app);

server.listen(PORT, () => {
    console.log(`World State Service API listening on port ${PORT}`);
});

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: WS_PORT });

console.log(`World State Service WebSocket listening on port ${WS_PORT}`);

wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected to World State WebSocket');

    // TODO: Add authentication/identification for connected clients (BSMs, Orchestrator)

    ws.on('message', (message: Buffer) => {
        try {
            const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
            console.log('Received WS message:', parsedMessage.type);

            // Handle incoming messages if WSS needs to react (e.g., broadcast updates)
            // For now, primarily BSMs report via HTTP POST
            // Orchestrator queries via HTTP GET

        } catch (error) {
            console.error('Failed to parse WebSocket message or handle:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected from World State WebSocket');
    });

    ws.on('error', (error: Error) => {
        console.error('World State WebSocket error:', error);
    });

    // Send a welcome message?
    // ws.send(JSON.stringify({ type: 'system::welcome', payload: 'Connected to World State Service WebSocket' }));
});

// --- Graceful Shutdown ---
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP and WebSocket servers');
    wss.close(() => console.log('WebSocket server closed.'));
    server.close(() => {
        console.log('HTTP server closed.');
        mongoose.connection.close(false).then(() => {
             console.log('MongoDB connection closed.');
             process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
     console.log('SIGINT signal received: closing HTTP and WebSocket servers');
     wss.close(() => console.log('WebSocket server closed.'));
     server.close(() => {
         console.log('HTTP server closed.');
         mongoose.connection.close(false).then(() => {
              console.log('MongoDB connection closed.');
              process.exit(0);
         });
     });
});