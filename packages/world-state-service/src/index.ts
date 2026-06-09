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
import Goal from './models/goal';

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
const POI_DEDUPLICATION_Y_THRESHOLD = 10; // Y-coordinate threshold for dedup
const RESOURCE_DEDUPLICATION_RADIUS = 5; // meters
const INFRA_DEDUPLICATION_RADIUS = 15; // meters
const DEFAULT_QUERY_LIMIT = 100; // Default limit for queries

// POI types that represent distinct, position-precise objects (e.g. containers).
// These must be deduped by EXACT coordinates so two chests in the same storage
// room aren't collapsed into one by the 10m radius dedup.
const POI_EXACT_DEDUP_TYPES = new Set(['chest', 'container', 'barrel', 'shulker_box', 'hopper', 'dispenser', 'dropper', 'furnace']);

// --- Payload Validation ---
function validateCoords(coords: any): coords is { x: number; y: number; z: number } {
    return coords &&
        typeof coords.x === 'number' &&
        typeof coords.y === 'number' &&
        typeof coords.z === 'number';
}

function validateReportPayload(report: any): string | null {
    if (!report || !report.dataType || !report.data) {
        return 'Missing dataType or data';
    }
    if (!report.reporterAgentId || typeof report.reporterAgentId !== 'string') {
        return 'Missing or invalid reporterAgentId';
    }

    switch (report.dataType) {
        case 'poi':
            if (!report.data.type || typeof report.data.type !== 'string') return 'POI: missing or invalid type';
            if (!validateCoords(report.data.coords)) return 'POI: missing or invalid coords';
            break;
        case 'resourceNode':
            if (!report.data.resourceType || typeof report.data.resourceType !== 'string') return 'ResourceNode: missing or invalid resourceType';
            if (!validateCoords(report.data.coords)) return 'ResourceNode: missing or invalid coords';
            break;
        case 'infrastructure':
            if (!report.data.type || typeof report.data.type !== 'string') return 'Infrastructure: missing or invalid type';
            if (!report.data.name || typeof report.data.name !== 'string') return 'Infrastructure: missing or invalid name';
            if (!validateCoords(report.data.coords)) return 'Infrastructure: missing or invalid coords';
            break;
        default:
            return `Unknown dataType: ${report.dataType}`;
    }
    return null; // Valid
}

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
  const report = req.body;

  // Validate payload
  const validationError = validateReportPayload(report);
  if (validationError) {
    logger.warn('Rejected invalid report', { error: validationError, body: report });
    metrics.increment('report_validation_errors');
    return res.status(400).json({ message: `Validation failed: ${validationError}` });
  }

  const typedReport = report as WorldStateReportPayload;

  logger.debug('Received report', {
    dataType: typedReport.dataType,
    agentId: typedReport.reporterAgentId
  });

  try {
    switch (typedReport.dataType) {
      case 'poi': {
        const isExactType = POI_EXACT_DEDUP_TYPES.has(typedReport.data.type.toLowerCase());

        // Containers (chests, etc.) are position-precise: dedup by EXACT coords so
        // distinct chests in a storage room are tracked separately. Other POI types
        // (caves, villages, etc.) use the 10m radius + Y-band dedup.
        const dedupFilter = isExactType
          ? {
              type: typedReport.data.type,
              'coords.x': typedReport.data.coords.x,
              'coords.y': typedReport.data.coords.y,
              'coords.z': typedReport.data.coords.z
            }
          : {
              type: typedReport.data.type,
              'coords.y': {
                $gte: typedReport.data.coords.y - POI_DEDUPLICATION_Y_THRESHOLD,
                $lte: typedReport.data.coords.y + POI_DEDUPLICATION_Y_THRESHOLD
              },
              coords: {
                $nearSphere: {
                  $geometry: {
                    type: "Point",
                    coordinates: [typedReport.data.coords.x, typedReport.data.coords.z]
                  },
                  $maxDistance: POI_DEDUPLICATION_RADIUS
                }
              }
            };

        const existingPOI = await POI.findOne(dedupFilter);

        if (existingPOI) {
          // Upsert: refresh the existing POI with the latest report so that
          // mutable data (e.g. chest details.contents) does not go stale.
          existingPOI.details = typedReport.data.details ?? existingPOI.details;
          if (typedReport.data.name !== undefined) existingPOI.name = typedReport.data.name;
          if (typedReport.data.biome !== undefined) existingPOI.biome = typedReport.data.biome;
          existingPOI.reporterAgentId = typedReport.reporterAgentId;
          existingPOI.lastUpdated = new Date();
          await existingPOI.save();
          logger.info('Existing POI updated', {
            type: typedReport.data.type,
            coords: typedReport.data.coords,
            exact: isExactType
          });
          metrics.increment('poi_updated');
        } else {
          await POI.create({
            ...typedReport.data,
            reporterAgentId: typedReport.reporterAgentId,
            lastUpdated: new Date()
          });
          logger.info('New POI stored', {
            type: typedReport.data.type,
            coords: typedReport.data.coords
          });
          metrics.increment('poi_created');
        }
        break;
      }

      case 'resourceNode': {
        const existingResource = await ResourceNode.findOne({
          resourceType: typedReport.data.resourceType,
          depleted: false,
          coords: {
            $nearSphere: {
              $geometry: {
                type: "Point",
                coordinates: [typedReport.data.coords.x, typedReport.data.coords.z]
              },
              $maxDistance: RESOURCE_DEDUPLICATION_RADIUS
            }
          }
        });

        if (existingResource) {
          logger.debug('Duplicate ResourceNode found, skipping', {
            type: typedReport.data.resourceType,
            coords: typedReport.data.coords
          });
          metrics.increment('resource_duplicates');
        } else {
          await ResourceNode.create(typedReport.data);
          logger.info('New ResourceNode stored', {
            type: typedReport.data.resourceType,
            coords: typedReport.data.coords
          });
          metrics.increment('resource_created');
        }
        break;
      }

      case 'infrastructure': {
        await Infrastructure.create(typedReport.data);
        logger.info('Infrastructure stored', {
          type: typedReport.data.type,
          name: typedReport.data.name
        });
        metrics.increment('infrastructure_created');
        break;
      }
    }

    metrics.record('report_processing_time', Date.now() - startTime);
    metrics.increment('reports_processed');
    res.status(201).json({ message: 'Report received and processed' });
  } catch (error) {
    logger.error('Error processing report', { error, report: typedReport });
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

    // Apply default limit if none specified
    const effectiveLimit = queryLimit > 0 ? queryLimit : DEFAULT_QUERY_LIMIT;

    switch (type) {
      case 'poi':
        query = POI.find(queryFilter).limit(effectiveLimit);
        results = await query.exec();
        break;
      case 'resourceNode':
        query = ResourceNode.find(queryFilter).limit(effectiveLimit);
        results = await query.exec();
        break;
      case 'infrastructure':
        query = Infrastructure.find(queryFilter).limit(effectiveLimit);
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

// --- Goal CRUD Endpoints ---

// POST /goals - Create a new goal
app.post('/goals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { goalId, type, description, priority, assignedAgents, state, parentGoal } = req.body;
    if (!goalId || !type || !description) {
      return res.status(400).json({ message: 'Missing required fields: goalId, type, description' });
    }
    const goal = await Goal.create({
      goalId, type, description,
      priority: priority ?? 'medium',
      status: 'active',
      assignedAgents: assignedAgents ?? [],
      state: state ?? {},
      parentGoal,
    });
    metrics.increment('goals_created');
    res.status(201).json(goal);
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(409).json({ message: `Goal ${req.body.goalId} already exists` });
    }
    next(error);
  }
});

// GET /goals - List goals (optionally filter by status)
app.get('/goals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: any = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.parentGoal) filter.parentGoal = req.query.parentGoal;
    const goals = await Goal.find(filter).sort({ priority: 1, createdAt: -1 }).limit(50);
    res.status(200).json(goals);
  } catch (error) {
    next(error);
  }
});

// GET /goals/:goalId - Get a specific goal
app.get('/goals/:goalId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const goal = await Goal.findOne({ goalId: req.params.goalId });
    if (!goal) return res.status(404).json({ message: 'Goal not found' });
    res.status(200).json(goal);
  } catch (error) {
    next(error);
  }
});

// PATCH /goals/:goalId - Update a goal
app.patch('/goals/:goalId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allowedUpdates = ['description', 'priority', 'status', 'assignedAgents', 'state'];
    const updates: any = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const goal = await Goal.findOneAndUpdate(
      { goalId: req.params.goalId },
      { $set: updates },
      { new: true }
    );
    if (!goal) return res.status(404).json({ message: 'Goal not found' });
    metrics.increment('goals_updated');
    res.status(200).json(goal);
  } catch (error) {
    next(error);
  }
});

// DELETE /goals/:goalId - Delete a goal
app.delete('/goals/:goalId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await Goal.findOneAndDelete({ goalId: req.params.goalId });
    if (!result) return res.status(404).json({ message: 'Goal not found' });
    metrics.increment('goals_deleted');
    res.status(200).json({ message: 'Goal deleted' });
  } catch (error) {
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
