import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import {
  WorldStateReportPayload,
  WebSocketMessage,
  createLogger,
  validateConfig,
  worldStateConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  HealthChecks,
  metrics,
  retryWithBackoff,
  ConnectionError
} from '@aetherius/shared-types';
import POI from './models/poi';
import ResourceNode from './models/resourceNode';
import Infrastructure from './models/infrastructure';

// --- Initialize Logger ---
const logger = createLogger('world-state-service');

// --- Validate Configuration ---
const config = validateConfig(worldStateConfigSchema, 'World State Service');

logger.info('Starting World State Service', {
  port: config.PORT,
  wsPort: config.WS_PORT,
  mongoUri: config.MONGO_URI.replace(/:[^:@]+@/, ':****@') // Hide password in logs
});

const POI_DEDUPLICATION_RADIUS = 10; // meters
const RESOURCE_DEDUPLICATION_RADIUS = 5; // meters
const INFRA_DEDUPLICATION_RADIUS = 15; // meters

// --- Express App Setup ---
const app = express();
app.use(express.json());

// --- MongoDB Connection with Retry ---
async function connectMongoDB() {
  try {
    await retryWithBackoff(
      () => mongoose.connect(config.MONGO_URI, {
        maxPoolSize: 10,
        minPoolSize: 2,
        socketTimeoutMS: 45000,
      }),
      {
        maxRetries: 5,
        baseDelay: 2000,
        onRetry: (error, attempt) => {
          logger.warn(`MongoDB connection attempt ${attempt} failed, retrying...`, { error: error.message });
        }
      }
    );
    logger.info('MongoDB connected successfully');
  } catch (error) {
    logger.error('Failed to connect to MongoDB after retries', { error });
    throw new ConnectionError('MongoDB connection failed', 'MongoDB');
  }
}

// --- Health Check Setup ---
const healthCheck = new HealthCheck('world-state-service', '0.1.0');

healthCheck.registerDependency('mongodb', async () => {
  return HealthChecks.mongodb(mongoose);
});

// --- API Endpoints ---

// GET /health - Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    const health = await healthCheck.check();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error('Health check failed', { error });
    res.status(503).json({
      service: 'world-state-service',
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /metrics - Metrics endpoint
app.get('/metrics', (req: Request, res: Response) => {
  const allMetrics = metrics.getAllMetrics();
  res.status(200).json(allMetrics);
});

// POST /report - Accepts reports from BSMs (originating from Agents)
app.post('/report', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const report = req.body as WorldStateReportPayload;

  logger.debug('Received report', {
    dataType: report.dataType,
    agentId: report.reporterAgentId
  });

  try {
    switch (report.dataType) {
      case 'poi': {
        const existingPOI = await POI.findOne({
          type: report.data.type,
          coords: {
            $nearSphere: {
              $geometry: {
                type: "Point",
                coordinates: [report.data.coords.x, report.data.coords.z]
              },
              $maxDistance: POI_DEDUPLICATION_RADIUS
            }
          }
        });

        if (existingPOI) {
          logger.debug('Duplicate POI found, skipping', {
            type: report.data.type,
            coords: report.data.coords
          });
          metrics.increment('poi_duplicates');
        } else {
          await POI.create(report.data);
          logger.info('New POI stored', {
            type: report.data.type,
            coords: report.data.coords
          });
          metrics.increment('poi_created');
        }
        break;
      }

      case 'resourceNode': {
        const existingResource = await ResourceNode.findOne({
          resourceType: report.data.resourceType,
          depleted: false,
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
          logger.debug('Duplicate ResourceNode found, skipping', {
            type: report.data.resourceType,
            coords: report.data.coords
          });
          metrics.increment('resource_duplicates');
        } else {
          await ResourceNode.create(report.data);
          logger.info('New ResourceNode stored', {
            type: report.data.resourceType,
            coords: report.data.coords
          });
          metrics.increment('resource_created');
        }
        break;
      }

      case 'infrastructure': {
        await Infrastructure.create(report.data);
        logger.info('Infrastructure stored', {
          type: report.data.type,
          name: report.data.name
        });
        metrics.increment('infrastructure_created');
        break;
      }

      default:
        logger.warn('Unknown report dataType', { dataType: (report as any).dataType });
        return res.status(400).json({ message: 'Invalid report type' });
    }

    metrics.record('report_processing_time', Date.now() - startTime);
    metrics.increment('reports_processed');
    res.status(201).json({ message: 'Report received and processed' });
  } catch (error) {
    logger.error('Error processing report', { error, report });
    metrics.increment('report_errors');
    next(error);
  }
});

// GET /query - Accepts queries from Orchestrator
app.get('/query', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const { type } = req.query;
  let queryFilter = {};
  let queryLimit = 0;

  logger.debug('Received query', { type, filter: req.query.filter });

  // Safely parse filter
  if (req.query.filter && typeof req.query.filter === 'string') {
    try {
      queryFilter = JSON.parse(req.query.filter);
    } catch (e) {
      logger.warn('Failed to parse query filter JSON', { error: e });
      return res.status(400).json({ message: 'Invalid filter JSON format' });
    }
  }

  // Safely parse options and extract limit
  if (req.query.options && typeof req.query.options === 'string') {
    try {
      const parsedOptions = JSON.parse(req.query.options);
      if (parsedOptions && typeof parsedOptions.limit === 'number' && parsedOptions.limit > 0) {
        queryLimit = Math.floor(parsedOptions.limit);
      } else if (parsedOptions && typeof parsedOptions.limit === 'string') {
        const parsedLimit = parseInt(parsedOptions.limit, 10);
        if (!isNaN(parsedLimit) && parsedLimit > 0) {
          queryLimit = parsedLimit;
        }
      }
    } catch (e) {
      logger.warn('Failed to parse query options JSON', { error: e });
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
      default:
        return res.status(400).json({ message: 'Invalid query type specified' });
    }

    logger.debug('Query successful', {
      type,
      resultCount: results.length,
      limit: queryLimit || 'none'
    });

    metrics.record('query_processing_time', Date.now() - startTime);
    metrics.increment('queries_processed');
    res.status(200).json(results);
  } catch (error) {
    logger.error('Error processing query', { error, type });
    metrics.increment('query_errors');
    next(error);
  }
});

// --- Error Handling Middleware ---
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error', { error: err.stack, path: req.path });
  res.status(500).json({ message: 'Internal Server Error' });
});

// --- HTTP Server ---
const server = http.createServer(app);

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: config.WS_PORT });

wss.on('connection', (ws: WebSocket) => {
  logger.info('Client connected to WebSocket');
  metrics.increment('ws_connections');

  ws.on('message', (message: Buffer) => {
    try {
      const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
      logger.debug('Received WS message', { type: parsedMessage.type });
      metrics.increment('ws_messages_received');
    } catch (error) {
      logger.error('Failed to parse WebSocket message', { error });
      metrics.increment('ws_message_errors');
    }
  });

  ws.on('close', () => {
    logger.info('Client disconnected from WebSocket');
    metrics.increment('ws_disconnections');
  });

  ws.on('error', (error: Error) => {
    logger.error('WebSocket error', { error });
    metrics.increment('ws_errors');
  });
});

// --- Graceful Shutdown ---
const shutdown = createGracefulShutdown(logger);

shutdown.register(async () => {
  logger.info('Closing WebSocket server...');
  wss.close();
});

shutdown.register(async () => {
  logger.info('Closing HTTP server...');
  return new Promise<void>((resolve) => {
    server.close(() => {
      logger.info('HTTP server closed');
      resolve();
    });
  });
});

shutdown.register(async () => {
  logger.info('Closing MongoDB connection...');
  await mongoose.connection.close(false);
  logger.info('MongoDB connection closed');
});

// --- Start Server ---
async function start() {
  try {
    await connectMongoDB();

    server.listen(config.PORT, () => {
      logger.info('World State Service started', {
        httpPort: config.PORT,
        wsPort: config.WS_PORT
      });
    });

    logger.info('World State WebSocket server started', { port: config.WS_PORT });
  } catch (error) {
    logger.error('Failed to start World State Service', { error });
    process.exit(1);
  }
}

start();
