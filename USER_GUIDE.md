# Aetherius User Guide

**Autonomous Minecraft Agent Swarm System**

A production-ready hierarchical AI system for managing autonomous Minecraft bot agents using Google Gemini AI for strategic and tactical planning.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Running the System](#running-the-system)
6. [Monitoring & Observability](#monitoring--observability)
7. [Service Details](#service-details)
8. [Troubleshooting](#troubleshooting)
9. [Development](#development)
10. [Production Deployment](#production-deployment)

---

## Architecture Overview

Aetherius uses a hierarchical architecture with 5 microservices:

```
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator Service                      │
│  Strategic AI Planning (Gemini 1.5 Pro)                     │
│  - High-level goal decomposition                            │
│  - Squad formation & mission assignment                     │
│  - World state analysis                                     │
└─────────────────┬──────────────────────┬────────────────────┘
                  │                      │
        ┌─────────▼──────────┐  ┌───────▼────────────┐
        │   Squad Leader     │  │   Squad Leader     │
        │ Tactical AI (Flash)│  │ Tactical AI (Flash)│
        │ - Mission execution│  │ - Mission execution│
        │ - Agent commands   │  │ - Agent commands   │
        └─────────┬──────────┘  └───────┬────────────┘
                  │                     │
        ┌─────────▼─────────────────────▼───────────┐
        │      Bot Server Manager (BSM)             │
        │  - Agent lifecycle management             │
        │  - Message routing (WS/TCP)               │
        │  - Process supervision                    │
        └─────────┬────────────────┬─────────────────┘
                  │                │
        ┌─────────▼──────┐  ┌─────▼────────┐
        │   Bot Agent    │  │  Bot Agent   │
        │  - Minecraft   │  │  - Minecraft │
        │  - Task exec   │  │  - Task exec │
        └────────┬───────┘  └──────┬───────┘
                 │                 │
                 └────────┬────────┘
                          │
                ┌─────────▼─────────┐
                │ World State Svc   │
                │  - MongoDB        │
                │  - POI tracking   │
                │  - Resource map   │
                └───────────────────┘
```

### Service Roles

| Service | Role | AI Model | Port |
|---------|------|----------|------|
| **Orchestrator** | Strategic planning & squad management | Gemini 1.5 Pro | HTTP: 5000, WS: 5001 |
| **Squad Leader** | Tactical execution & agent coordination | Gemini 1.5 Flash | Dynamic (spawned) |
| **Bot Server Manager** | Agent lifecycle & message routing | None | HTTP: 4002, WS: 4000, TCP: 4001 |
| **Bot Agent** | Minecraft interaction & task execution | None | Dynamic (spawned) |
| **World State** | Persistent world knowledge | None | HTTP: 3000, WS: 3001 |

---

## Prerequisites

### System Requirements

- **OS**: Linux, macOS, or Windows (WSL recommended)
- **Node.js**: v18.0.0 or higher
- **pnpm**: v8.0.0 or higher
- **MongoDB**: v5.0 or higher
- **Memory**: Minimum 4GB RAM (8GB+ recommended)
- **Minecraft Server**: 1.20.1 (or configure version)

### Required Accounts

1. **Google Cloud Account** with Gemini API access
   - Get API key from: https://aistudio.google.com/app/apikey
   - Quota needed:
     - Gemini 1.5 Pro: 60 requests/minute
     - Gemini 1.5 Flash: 1500 requests/minute

2. **Minecraft Server** (self-hosted or third-party)
   - Java Edition 1.20.1
   - Must allow bot connections

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/Nectar.git
cd Nectar
```

### 2. Install Dependencies

```bash
pnpm install
```

This installs all dependencies for the monorepo workspace.

### 3. Build All Services

```bash
pnpm run build
```

Expected output:
```
✓ packages/shared-types build: Done
✓ packages/pathfinder build: Done
✓ packages/combat build: Done
✓ packages/bot-agent build: Done
✓ packages/bot-server-manager build: Done
✓ packages/orchestrator-service build: Done
✓ packages/squad-leader build: Done
✓ packages/world-state-service build: Done
```

### 4. Start MongoDB

```bash
# Using Docker (recommended)
docker run -d \
  --name aetherius-mongo \
  -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=admin \
  -e MONGO_INITDB_ROOT_PASSWORD=password \
  mongo:5.0

# Or use local MongoDB installation
mongod --dbpath /path/to/data
```

---

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# --- Google Gemini AI ---
GEMINI_API_KEY=your-gemini-api-key-here

# --- MongoDB ---
MONGO_URI=mongodb://admin:password@localhost:27017/aetherius?authSource=admin

# --- World State Service ---
WORLD_STATE_PORT=3000
WORLD_STATE_WS_PORT=3001

# --- Orchestrator Service ---
ORCHESTRATOR_PORT=5000
ORCHESTRATOR_WS_PORT=5001
WORLD_STATE_API_ADDRESS=http://localhost:3000
SQUAD_LEADER_SCRIPT_PATH=./packages/squad-leader/dist/index.js

# --- Bot Server Manager ---
BSM_ID=bsm-main
BSM_WS_PORT=4000
BSM_AGENT_PORT=4001
BSM_HTTP_PORT=4002
BSM_HOST=127.0.0.1
AGENT_SCRIPT_PATH=../bot-agent/dist/index.js

# --- Squad Leader (template) ---
SQUAD_ID=squad-001
ORCHESTRATOR_ADDRESS=ws://localhost:5001

# --- Bot Agent (template) ---
AGENT_ID=agent-001
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.20.1
BSM_HOST=127.0.0.1
BSM_TCP_PORT=4001

# --- Logging ---
LOG_LEVEL=info
LOG_FILE=./logs/aetherius.log
```

### Service-Specific Configuration

Each service validates its configuration using Zod schemas. Missing required variables will cause startup failures with helpful error messages.

#### Required Variables by Service

**World State Service:**
- `MONGO_URI` - MongoDB connection string
- `WORLD_STATE_PORT` - HTTP port (default: 3000)
- `WORLD_STATE_WS_PORT` - WebSocket port (default: 3001)

**Orchestrator Service:**
- `GEMINI_API_KEY` - Google Gemini API key
- `ORCHESTRATOR_PORT` - HTTP port (default: 5000)
- `ORCHESTRATOR_WS_PORT` - WebSocket port (default: 5001)
- `WORLD_STATE_API_ADDRESS` - World State HTTP endpoint

**Bot Server Manager:**
- `BSM_WS_PORT` - WebSocket port for commanders (default: 4000)
- `BSM_AGENT_PORT` - TCP port for agents (default: 4001)
- `ORCHESTRATOR_ADDRESS` - Orchestrator WebSocket endpoint
- `WORLD_STATE_API_ADDRESS` - World State HTTP endpoint

**Squad Leader:**
- `GEMINI_API_KEY` - Google Gemini API key
- `SQUAD_ID` - Unique squad identifier
- `ORCHESTRATOR_ADDRESS` - Orchestrator WebSocket endpoint

**Bot Agent:**
- `AGENT_ID` - Unique agent identifier
- `MC_HOST` - Minecraft server hostname
- `MC_PORT` - Minecraft server port
- `BSM_HOST` - BSM hostname
- `BSM_TCP_PORT` - BSM TCP port

---

## Running the System

### Development Mode (Manual)

Start each service in a separate terminal:

```bash
# Terminal 1: MongoDB
docker start aetherius-mongo

# Terminal 2: World State Service
cd packages/world-state-service
node dist/index.js

# Terminal 3: Bot Server Manager
cd packages/bot-server-manager
node dist/index.js

# Terminal 4: Orchestrator Service
cd packages/orchestrator-service
node dist/index.js
```

### Development Mode (Automated)

Use the provided development script:

```bash
./start-dev.sh
```

This script uses `tmux` to start all services in split panes. Press `Ctrl+B` then `D` to detach.

**Stop services:**
```bash
./stop-dev.sh
```

### Production Mode

Use a process manager like PM2:

```bash
# Install PM2
npm install -g pm2

# Create ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'world-state',
      script: './packages/world-state-service/dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'bot-server-manager',
      script: './packages/bot-server-manager/dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    },
    {
      name: 'orchestrator',
      script: './packages/orchestrator-service/dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G'
    }
  ]
};
EOF

# Start services
pm2 start ecosystem.config.js

# View logs
pm2 logs

# Stop services
pm2 stop all
```

---

## Monitoring & Observability

### Health Check Endpoints

All services expose health check endpoints:

```bash
# World State Service
curl http://localhost:3000/health

# Orchestrator Service
curl http://localhost:5000/health

# Bot Server Manager
curl http://localhost:4002/health
```

**Healthy Response:**
```json
{
  "service": "orchestrator-service",
  "version": "0.1.0",
  "status": "healthy",
  "timestamp": "2025-11-19T10:30:00.000Z",
  "dependencies": {
    "world-state-service": { "status": "connected" },
    "gemini-api": { "status": "connected" }
  }
}
```

**Degraded Response:**
```json
{
  "service": "orchestrator-service",
  "status": "degraded",
  "dependencies": {
    "gemini-api": {
      "status": "degraded",
      "error": "Circuit breaker open"
    }
  }
}
```

### Metrics Endpoints

Get real-time metrics from each service:

```bash
# World State Service metrics
curl http://localhost:3000/metrics

# Orchestrator Service metrics
curl http://localhost:5000/metrics

# Bot Server Manager metrics
curl http://localhost:4002/metrics
```

**Example Metrics Response:**
```json
{
  "counters": {
    "strategic_planning_cycles": 45,
    "llm_cache_hits": 18,
    "llm_cache_misses": 27,
    "squads_created": 12,
    "agents_selected": 48,
    "world_state_queries_successful": 67
  },
  "histograms": {
    "strategic_planning_duration": {
      "count": 45,
      "min": 1234,
      "max": 8765,
      "mean": 3456,
      "p50": 3200,
      "p95": 6500,
      "p99": 8100
    },
    "llm_strategic_call": {
      "count": 27,
      "mean": 2100
    }
  }
}
```

### Key Metrics to Monitor

**Orchestrator Service:**
- `strategic_planning_cycles` - Number of planning cycles executed
- `llm_cache_hits` / `llm_cache_misses` - Cache efficiency (~40% hit rate expected)
- `squads_created` / `squads_terminated` - Squad lifecycle
- `strategic_planning_duration` - Planning performance (target: <5s p95)
- `strategic_planning_errors` - LLM failures

**Squad Leader:**
- `tactical_planning_cycles` - Tactical planning frequency
- `llm_tactical_cache_hits` / `llm_tactical_cache_misses` - Cache performance
- `commands_sent` - Commands dispatched to agents
- `missions_completed` / `missions_failed` - Success rate
- `tactical_planning_duration` - Planning speed (target: <2s p95)

**Bot Server Manager:**
- `agents_spawned` / `agents_exited` - Agent lifecycle
- `ws_connections` / `tcp_connections` - Connection health
- `messages_forwarded_to_commander` - Message throughput
- `world_state_reports_sent` - World State updates

**Bot Agent:**
- `commands_received` - Tasks received
- `events_reported` - Events sent to commander
- `minecraft_spawns` / `minecraft_disconnects` - Minecraft health
- `bsm_connections` / `bsm_disconnections` - BSM connectivity

**World State Service:**
- `reports_processed` - Incoming data rate
- `poi_created` / `resource_created` - World discoveries
- `queries_processed` - Query load
- `report_processing_time` - Processing performance

### Logging

All services use Winston for structured JSON logging.

**Log Locations:**
- Console: All services log to stdout/stderr
- File: Configure `LOG_FILE` env var for file output

**Log Levels:**
- `error` - Failures requiring attention
- `warn` - Potential issues (reconnections, cache misses)
- `info` - Normal operations (default)
- `debug` - Detailed debugging (set `LOG_LEVEL=debug`)

**Example Log Entry:**
```json
{
  "level": "info",
  "message": "Strategic planning cycle completed",
  "service": "orchestrator-service",
  "timestamp": "2025-11-19T10:30:15.234Z",
  "durationMs": 3456,
  "triggeredBy": "missionComplete"
}
```

### Monitoring Dashboard Setup

Use Grafana + Prometheus for visualization:

1. **Export metrics in Prometheus format:**
   - Add prometheus exporter middleware to services
   - Scrape `/metrics` endpoints

2. **Key Dashboard Panels:**
   - LLM cache hit rate (target: 30-50%)
   - Planning cycle duration (p50, p95, p99)
   - Squad success/failure rates
   - Agent connection stability
   - Circuit breaker state

---

## Service Details

### World State Service

**Purpose:** Persistent knowledge base for world discoveries

**Key Features:**
- MongoDB storage for POIs, resources, infrastructure
- Deduplication using geospatial queries
- WebSocket updates for real-time sync
- Health checks for MongoDB connectivity

**Endpoints:**
- `POST /report` - Submit world state reports
- `GET /query?type=poi&filter={...}` - Query world data
- `GET /health` - Health check
- `GET /metrics` - Metrics

**Data Types:**
```typescript
// POI (Point of Interest)
{
  type: "village" | "spawner" | "end_portal_frame",
  coords: { x: number, y: number, z: number },
  discoveredBy: "agent-id",
  timestamp: "ISO-8601"
}

// Resource Node
{
  resourceType: "iron_ore" | "diamond_ore",
  coords: { x, y, z },
  depleted: false,
  estimatedQuantity: number
}

// Infrastructure
{
  type: "base" | "farm" | "storage",
  name: "Main Base",
  coords: { x, y, z },
  details: object
}
```

### Orchestrator Service

**Purpose:** Strategic AI planner and squad manager

**Key Features:**
- Gemini 1.5 Pro for high-level planning
- Circuit breaker (5 failures, 60s reset)
- LLM cache (5 min TTL, ~40% cost reduction)
- Rate limiting (60 calls/minute)
- Squad lifecycle management
- Agent selection (tags, inventory, proximity)

**WebSocket Messages:**
```typescript
// From BSM
{ type: 'bsm::register', payload: { bsmId, address, agents } }

// From Squad Leader
{ type: 'squadLeader::statusUpdate', payload: { squadId, status, progress } }
{ type: 'squadLeader::missionComplete', payload: { squadId, results } }
{ type: 'squadLeader::missionFailed', payload: { squadId, reason } }

// To Squad Leader
{ type: 'squadLeader::init', payload: { squadId, missionDescription, assignedAgents } }
{ type: 'squadLeader::terminate', payload: { reason } }
```

**LLM Tools:**
- `delegateTaskToSquad` - Create squad and assign mission
- `requestWorldStateQuery` - Query world knowledge
- `setPlanRepresentation` - Update strategic plan

### Bot Server Manager

**Purpose:** Agent lifecycle manager and message router

**Key Features:**
- Spawns/terminates bot agent processes
- WebSocket server for Orchestrator/Squad Leaders
- TCP server for bot agents
- Intelligent message routing
- Health checks for dependencies

**Message Routing:**
```
Agent → BSM (TCP) → Commander (WebSocket)
Commander → BSM (WebSocket) → Agent (TCP)
Agent → BSM → World State (HTTP)
```

**Managed Process Lifecycle:**
1. Orchestrator requests agent spawn
2. BSM forks bot agent process
3. Agent connects via TCP and registers
4. BSM marks agent as "running"
5. Commander sends commands via BSM
6. Agent reports events/status via BSM
7. BSM terminates agent on request (SIGTERM → SIGKILL)

### Squad Leader

**Purpose:** Tactical mission executor

**Key Features:**
- Gemini 1.5 Flash for fast tactical decisions
- Circuit breaker (5 failures, 60s reset)
- LLM cache (3 min TTL - faster than strategic)
- Rate limiting (1500 calls/minute)
- Multi-agent coordination
- Event-driven replanning

**Lifecycle:**
1. Spawned by Orchestrator (fork)
2. Connects to Orchestrator via WebSocket
3. Receives init with mission + agents
4. Connects to BSMs for agent communication
5. Runs tactical planning loop
6. Issues commands to agents
7. Reports status/findings to Orchestrator
8. Terminates on mission complete/fail

**LLM Tools:**
- `agentCommandBatch` - Send commands to multiple agents
- `reportStatusToOrchestrator` - Update mission progress
- `reportStrategicFindToOrchestrator` - Report important discoveries
- `declareMissionComplete` - Mission succeeded
- `declareMissionFailed` - Mission failed

### Bot Agent

**Purpose:** Minecraft interaction and task execution

**Key Features:**
- Mineflayer-based Minecraft bot
- TCP connection to BSM
- Task execution system (NavigateTo, Gather, Attack, etc.)
- Event reporting (task completion, POI discoveries, threats)
- Graceful disconnect from Minecraft/BSM

**Task Types:**
- `NavigateTo` - Move to coordinates
- `Gather` - Collect resources
- `Attack` - Combat entity
- `Build` - Place blocks
- `Craft` - Craft items
- `Mine` - Break blocks

**Event Types:**
- `taskComplete` - Task finished successfully
- `taskFailed` - Task failed (with reason)
- `foundPOI` - Discovered point of interest
- `foundResource` - Found resource node
- `detectedThreat` - Enemy/danger nearby
- `tookDamage` - Agent damaged
- `agentDied` - Agent killed

---

## Troubleshooting

### Service Won't Start

**Symptom:** Service exits immediately with config error

**Solution:** Check environment variables
```bash
# World State Service example
node packages/world-state-service/dist/index.js

# Look for validation error:
# "Config validation failed: MONGO_URI is required"
```

Fix: Add missing variable to `.env`

### MongoDB Connection Failed

**Symptom:**
```
ERROR: Failed to connect to MongoDB after retries
ERROR: MongoDB connection failed
```

**Solutions:**
1. Check MongoDB is running: `docker ps` or `systemctl status mongod`
2. Verify connection string in `MONGO_URI`
3. Test connection: `mongosh "mongodb://admin:password@localhost:27017"`
4. Check firewall rules allow port 27017

### Gemini API Errors

**Symptom:**
```
ERROR: Error during strategic planning LLM interaction
WARN: Gemini API circuit breaker state changed: open
```

**Solutions:**
1. Verify API key is valid: https://aistudio.google.com/app/apikey
2. Check quota limits (60 req/min Pro, 1500 req/min Flash)
3. Wait for circuit breaker reset (60 seconds)
4. Check Gemini API status: https://status.cloud.google.com/

### Squad Leader Not Spawning

**Symptom:**
```
ERROR: Error spawning squad leader process
```

**Solutions:**
1. Check `SQUAD_LEADER_SCRIPT_PATH` points to built file
2. Verify file exists: `ls packages/squad-leader/dist/index.js`
3. Rebuild if missing: `pnpm --filter @aetherius/squad-leader run build`
4. Check permissions: `chmod +x packages/squad-leader/dist/index.js`

### Agent Can't Connect to Minecraft

**Symptom:**
```
ERROR: Bot agent-001 error: Error: connect ECONNREFUSED
```

**Solutions:**
1. Verify Minecraft server is running
2. Check `MC_HOST` and `MC_PORT` are correct
3. Test connection: `telnet localhost 25565`
4. Check Minecraft allows bot connections (online-mode, whitelist)
5. Verify Minecraft version matches `MC_VERSION`

### High Memory Usage

**Symptom:** Service using excessive RAM

**Solutions:**
1. Check for memory leaks in metrics
2. Reduce LLM cache TTL (smaller cache)
3. Limit concurrent squads
4. Restart services periodically
5. Use PM2 `max_memory_restart` option

### Circuit Breaker Stuck Open

**Symptom:** Continuous "Circuit breaker open" warnings

**Solutions:**
1. Check Gemini API is accessible
2. Verify API key quota not exceeded
3. Wait 60 seconds for automatic reset
4. Restart service to force reset
5. Increase `resetTimeout` if transient issues

---

## Development

### Building Individual Services

```bash
# Build specific service
pnpm --filter @aetherius/orchestrator-service run build

# Build with dependencies
pnpm --filter @aetherius/bot-agent... run build

# Build all
pnpm run build
```

### Running Tests

```bash
# Run all tests
pnpm test

# Test specific package
pnpm --filter @aetherius/shared-types test

# Watch mode
pnpm --filter @aetherius/orchestrator-service test -- --watch
```

### Code Structure

```
Nectar/
├── packages/
│   ├── shared-types/          # Shared TypeScript types & utilities
│   │   ├── src/
│   │   │   ├── logger.ts      # Winston logger factory
│   │   │   ├── config.ts      # Zod schemas & validation
│   │   │   ├── resilience.ts  # Circuit breaker, cache, rate limiter
│   │   │   ├── health.ts      # Health check utilities
│   │   │   └── metrics.ts     # Metrics collection
│   │   └── package.json
│   ├── world-state-service/   # World knowledge database
│   ├── orchestrator-service/  # Strategic AI planner
│   ├── bot-server-manager/    # Agent lifecycle manager
│   ├── squad-leader/          # Tactical AI executor
│   ├── bot-agent/             # Minecraft bot
│   ├── pathfinder/            # Pathfinding plugin
│   └── combat/                # Combat plugin
├── .env                       # Environment variables
├── ecosystem.config.js        # PM2 configuration
├── start-dev.sh              # Development startup script
├── stop-dev.sh               # Development shutdown script
├── INTEGRATION_STATUS.md     # Integration progress
└── USER_GUIDE.md             # This file
```

### Adding New Features

1. **Add to shared-types** if needed (new message types, schemas)
2. **Update service** with new functionality
3. **Add metrics** for observability
4. **Update health checks** if dependencies change
5. **Test locally** with all services running
6. **Update documentation**

---

## Production Deployment

### Pre-Deployment Checklist

- [ ] All services build successfully
- [ ] Environment variables configured
- [ ] MongoDB connection tested
- [ ] Gemini API key validated
- [ ] Health checks return healthy
- [ ] Metrics endpoints responding
- [ ] Logs configured and rotating
- [ ] Process manager configured (PM2)
- [ ] Monitoring dashboards set up
- [ ] Backup strategy for MongoDB

### Deployment Steps

1. **Prepare Environment**
```bash
# Production server
ssh user@production-server
cd /opt/aetherius
git pull origin main
pnpm install --frozen-lockfile
pnpm run build
```

2. **Configure Environment**
```bash
# Copy and edit production .env
cp .env.example .env
nano .env
# Set production values (MongoDB URI, API keys, etc.)
```

3. **Start Services**
```bash
# Using PM2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup  # Enable auto-start on boot
```

4. **Verify Deployment**
```bash
# Check all services are running
pm2 status

# Check health endpoints
curl http://localhost:3000/health  # World State
curl http://localhost:5000/health  # Orchestrator
curl http://localhost:4002/health  # BSM

# View logs
pm2 logs
```

5. **Monitor**
```bash
# Watch metrics
watch -n 5 'curl -s http://localhost:5000/metrics | jq .'

# Set up alerts for:
# - Service down (health check failures)
# - High error rates
# - Circuit breaker open
# - Memory/CPU usage
```

### Scaling Considerations

**Horizontal Scaling:**
- Run multiple BSM instances with load balancing
- Each BSM manages separate agent pools
- Orchestrator connects to all BSMs

**Vertical Scaling:**
- Orchestrator: 1-2 GB RAM (LLM cache)
- Squad Leader: 512 MB RAM per instance
- BSM: 512 MB RAM + 100 MB per agent
- Bot Agent: 100-200 MB RAM each
- World State: 512 MB RAM + MongoDB size

**Cost Optimization:**
- LLM caching reduces API costs by ~40%
- Monitor cache hit rates in metrics
- Adjust cache TTL based on use case
- Use Gemini Flash for tactical (25x cheaper)

### Backup & Recovery

**MongoDB Backup:**
```bash
# Automated daily backup
0 2 * * * mongodump --uri="$MONGO_URI" --out=/backups/$(date +\%Y\%m\%d)

# Restore
mongorestore --uri="$MONGO_URI" /backups/20251119
```

**Configuration Backup:**
- Store `.env` in secure secret manager
- Version control ecosystem.config.js
- Document custom configurations

---

## Quick Reference

### Useful Commands

```bash
# Check service status
pm2 status

# View logs (all services)
pm2 logs

# View logs (specific service)
pm2 logs orchestrator

# Restart service
pm2 restart orchestrator

# Stop all services
pm2 stop all

# View metrics
curl http://localhost:5000/metrics | jq .

# Health check all services
for port in 3000 5000 4002; do
  echo "Port $port:"
  curl -s http://localhost:$port/health | jq .status
done

# Monitor MongoDB
mongosh "mongodb://admin:password@localhost:27017"
> use aetherius
> db.pois.countDocuments()
> db.resourcenodes.countDocuments()

# Check agent connections
curl http://localhost:4002/ | jq .
```

### Default Ports

| Service | HTTP | WebSocket | TCP |
|---------|------|-----------|-----|
| World State | 3000 | 3001 | - |
| Orchestrator | 5000 | 5001 | - |
| BSM | 4002 | 4000 | 4001 |

### Support

- **Documentation**: See README.md and INTEGRATION_STATUS.md
- **Issues**: GitHub Issues
- **Logs**: Check Winston logs for detailed errors
- **Health**: Use `/health` endpoints for diagnostics
- **Metrics**: Use `/metrics` endpoints for performance data

---

## License

MIT License - See LICENSE file for details

---

**Version**: 1.0.0
**Last Updated**: 2025-11-19
**Status**: Production Ready (5/5 services integrated)
