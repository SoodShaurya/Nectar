# Aetherius User Guide

**Autonomous Minecraft Agent Swarm System**

A system for managing autonomous Minecraft bot agents driven by a single conversational Coordinator
(DeepSeek deepseek-v4-flash) that plans, maintains a persistent goal board, and dispatches tasks to agents.

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

Aetherius is built around a single conversational **Coordinator** that dispatches tasks directly to agents
through one or more Bot Server Managers (BSMs). The earlier Orchestrator + Squad Leader tiers have been
removed (those packages are archived under `packages/_archived_*`).

```
                ┌───────────────────────────────────────────┐
                │              Coordinator                   │
                │  Conversational AI (DeepSeek v4-pro)       │
                │  - Goal board (MongoDB-persisted)          │
                │  - Deterministic crafting task-trees       │
                │  - Direct task dispatch to agents          │
                └───────┬──────────────────────────┬─────────┘
                        │ WS (commands/acks)        │ HTTP
                        ▼                           ▼
        ┌───────────────────────────┐   ┌───────────────────┐
        │  Bot Server Manager (BSM) │   │ World State Svc    │
        │  - Spawns/supervises       │   │  - MongoDB        │
        │    bot-agent processes     │   │  - Goal board     │
        │  - Routes WS ⇄ TCP         │   │  - POI tracking   │
        │  - Bounded outbound queue  │   │  - Resource map   │
        └─────────┬────────────────┬─┘   └───────────────────┘
                  │ TCP            │ TCP            ▲
        ┌─────────▼──────┐  ┌─────▼────────┐       │ HTTP reports
        │   Bot Agent    │  │  Bot Agent   │───────┘
        │  - Minecraft   │  │  - Minecraft │
        │  - 50ms react. │  │  - 50ms react│
        │  - Skill mods  │  │  - Skill mods│
        └────────────────┘  └──────────────┘
```

Inter-service messages are versioned and schema-validated (see `@aetherius/shared-types`). Commands are
acknowledged: the Coordinator marks an agent `pending` until the agent's ack is relayed back by the BSM,
then `busy`. An optional `CLUSTER_AUTH_TOKEN` shared secret can be required for BSM/agent registration.

### Service Roles

| Service | Role | AI Model | Port |
|---------|------|----------|------|
| **Coordinator** | Conversational planning, goal board, task dispatch | DeepSeek deepseek-v4-flash | HTTP: 5000, WS: 5001 |
| **Bot Server Manager** | Agent lifecycle & message routing | None | HTTP: 4002, WS: 4000, TCP: 4001 |
| **Bot Agent** | Minecraft interaction & task execution | None | Connects to BSM TCP (4001) |
| **World State** | Persistent world knowledge & goal board | None | HTTP: 3000, WS: 3001 |

---

## Prerequisites

### System Requirements

- **OS**: Linux, macOS, or Windows (WSL recommended)
- **Node.js**: v20.0.0 or higher
- **pnpm**: v8.0.0 or higher
- **MongoDB**: v5.0 or higher
- **Memory**: Minimum 4GB RAM (8GB+ recommended)
- **Minecraft Server**: 1.21.1

### Required Accounts

1. **DeepSeek API access**
   - Get API key from: https://platform.deepseek.com/api_keys
   - The Coordinator uses the DeepSeek deepseek-v4-flash model via the OpenAI-compatible `openai` SDK pointed at https://api.deepseek.com
   - Set this key as `DEEPSEEK_API_KEY`

2. **Minecraft Server** (self-hosted or third-party)
   - Java Edition 1.21.1
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

Expected output (active packages; archived packages are excluded from the build):
```
✓ packages/shared-types build: Done
✓ packages/world-state-service build: Done
✓ packages/bot-agent build: Done
✓ packages/bot-server-manager build: Done
✓ packages/coordinator build: Done
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
# --- DeepSeek AI (Coordinator) ---
DEEPSEEK_API_KEY=your-deepseek-api-key-here
# Optional: override the coordinator model (default: deepseek-v4-flash; only deepseek-v4-* values are accepted)
# COORDINATOR_MODEL=deepseek-v4-pro

# --- MongoDB (World State Service) ---
MONGO_URI=mongodb://admin:password@localhost:27017/aetherius?authSource=admin

# --- World State Service ---
PORT=3000          # HTTP
WS_PORT=3001       # WebSocket

# --- Coordinator ---
COORDINATOR_PORT=5000        # HTTP
COORDINATOR_WS_PORT=5001     # WebSocket (BSMs connect in)
WORLD_STATE_API_ADDRESS=http://localhost:3000
MC_VERSION=1.21.1

# --- Bot Server Manager (BSM) ---
BSM_ID=bsm-main
BSM_WS_PORT=4000             # upstream WS (legacy/optional)
BSM_AGENT_PORT=4001          # TCP port agents connect to
BSM_HTTP_PORT=4002           # health/metrics
BSM_HOST=127.0.0.1
COORDINATOR_ADDRESS=ws://localhost:5001   # upstream Coordinator (preferred)
AGENT_SCRIPT_PATH=../bot-agent/dist/index.js
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.21.1

# --- Bot Agent (template; usually spawned by the BSM) ---
AGENT_ID=agent-001
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.21.1
MC_AUTH=offline              # or "microsoft" (set MC_USERNAME for online-mode)
BSM_HOST=127.0.0.1
BSM_TCP_PORT=4001

# --- Optional shared-secret auth (set the SAME value everywhere, or leave unset) ---
CLUSTER_AUTH_TOKEN=
```

### Service-Specific Configuration

Each service validates its configuration using Zod schemas. Missing required variables will cause startup failures with helpful error messages.

#### Required Variables by Service

**World State Service:**
- `MONGO_URI` - MongoDB connection string (required)
- `PORT` - HTTP port (default: 3000)
- `WS_PORT` - WebSocket port (default: 3001)

**Coordinator:**
- `DEEPSEEK_API_KEY` - DeepSeek API key (required)
- `COORDINATOR_MODEL` - Coordinator LLM model (default: deepseek-v4-flash; restricted to deepseek-v4-* variants, e.g. deepseek-v4-pro)
- `COORDINATOR_PORT` - HTTP port (default: 5000)
- `COORDINATOR_WS_PORT` - WebSocket port BSMs connect to (default: 5001)
- `WORLD_STATE_API_ADDRESS` - World State HTTP endpoint (default: http://localhost:3000)
- `MC_VERSION` - Minecraft version for crafting data (default: 1.21.1)
- `CLUSTER_AUTH_TOKEN` - Optional shared secret BSMs must present to register

**Bot Server Manager:**
- `BSM_WS_PORT` - Upstream WebSocket port (default: 4000)
- `BSM_AGENT_PORT` - TCP port agents connect to (default: 4001)
- `BSM_HTTP_PORT` - HTTP health/metrics port (default: 4002)
- `COORDINATOR_ADDRESS` - Coordinator WebSocket endpoint (default: ws://localhost:5001;
  the deprecated alias `ORCHESTRATOR_ADDRESS` is still accepted with a warning)
- `WORLD_STATE_API_ADDRESS` - World State HTTP endpoint (default: http://localhost:3000)
- `MC_HOST` / `MC_PORT` / `MC_VERSION` - Minecraft server details passed to spawned agents
- `CLUSTER_AUTH_TOKEN` - Optional shared secret presented upstream and required from agents

**Bot Agent:**
- `AGENT_ID` - Unique agent identifier
- `MC_HOST` / `MC_PORT` / `MC_VERSION` - Minecraft server details
- `MC_AUTH` - `offline` (default) or `microsoft` (set `MC_USERNAME` for online-mode)
- `BSM_HOST` - BSM hostname (default: 127.0.0.1)
- `BSM_TCP_PORT` - BSM TCP port (default: 4001)
- `CLUSTER_AUTH_TOKEN` - Optional shared secret presented to the BSM on registration

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

# Terminal 4: Coordinator
cd packages/coordinator
node dist/index.js
```

The Coordinator listens for BSM WebSocket connections on port 5001; the BSM connects upstream to it
(`COORDINATOR_ADDRESS`) and spawns bot-agents on demand. You can also use
`pnpm --filter @aetherius/<service> start` instead of `node dist/index.js`.

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
      name: 'coordinator',
      script: './packages/coordinator/dist/index.js',
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

# Coordinator
curl http://localhost:5000/health

# Bot Server Manager
curl http://localhost:4002/health
```

**Healthy Response:**
```json
{
  "service": "coordinator",
  "version": "0.1.0",
  "status": "healthy",
  "timestamp": "2026-06-08T10:30:00.000Z",
  "dependencies": {
    "world-state-service": { "status": "connected" },
    "deepseek-api": { "status": "connected" }
  }
}
```

**Degraded Response:**
```json
{
  "service": "coordinator",
  "status": "degraded",
  "dependencies": {
    "deepseek-api": {
      "status": "degraded",
      "error": "API unavailable"
    }
  }
}
```

### Metrics Endpoints

Get real-time metrics from each service:

```bash
# World State Service metrics
curl http://localhost:3000/metrics

# Coordinator metrics
curl http://localhost:5000/metrics

# Bot Server Manager metrics
curl http://localhost:4002/metrics
```

**Example Metrics Response:**
```json
{
  "counters": {
    "llm_invocations": 45,
    "commands_dispatched": 38,
    "command_acks_received": 36,
    "goals_completed": 12,
    "world_state_queries_successful": 67
  },
  "histograms": {
    "llm_invocation_duration": {
      "count": 45,
      "min": 1234,
      "max": 8765,
      "mean": 3456,
      "p50": 3200,
      "p95": 6500,
      "p99": 8100
    }
  }
}
```

### Key Metrics to Monitor

> Metric names below are representative; consult each service's source for the exact counters it emits.

**Coordinator:**
- LLM planning cycles / invocations
- Commands dispatched and acknowledgments received
- Goal-board updates (goals created / completed / failed)
- Command-ack timeouts and triggered replans
- BSM connect/disconnect events

**Bot Server Manager:**
- `agents_spawned` / `agents_exited` - Agent lifecycle
- `ws_connections` / `tcp_connections` - Connection health
- `agent_outbound_queued` / `agent_outbound_flushed` / `agent_outbound_dropped` - Outbound queue health
- `ws_invalid_payloads` - Dropped messages that failed validation
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
  "message": "Coordinator planning cycle completed",
  "service": "coordinator",
  "timestamp": "2026-06-08T10:30:15.234Z",
  "durationMs": 3456,
  "triggeredBy": "agent::commandAck"
}
```

### Monitoring Dashboard Setup

Use Grafana + Prometheus for visualization:

1. **Export metrics in Prometheus format:**
   - Add prometheus exporter middleware to services
   - Scrape `/metrics` endpoints

2. **Key Dashboard Panels:**
   - Planning cycle duration (p50, p95, p99)
   - Goal success/failure rates
   - Command-ack latency and timeout rate
   - Agent connection stability
   - Outbound queue depth / drop rate

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

### Coordinator

**Purpose:** Conversational AI planner, goal-board owner, and task dispatcher

**Key Features:**
- DeepSeek deepseek-v4-flash (OpenAI-compatible `openai` SDK) for conversational planning
- MongoDB-persisted goal board (via the World State Service)
- Deterministic crafting task-tree resolution (no LLM tokens spent on recipes)
- Direct task dispatch to agents through BSMs, with command acknowledgments
- Replans on command rejections, ack timeouts, and BSM disconnects

**WebSocket Messages** (constants from `@aetherius/shared-types`; the protocol is versioned + validated):
```typescript
// From BSM
{ type: 'bsm::register',       payload: { bsmId, address, agents, authToken? } }
{ type: 'agent::statusUpdate', payload: { /* agent status */ } }
{ type: 'agent::commandAck',   payload: { agentId, taskId, accepted, reason? } }
{ type: 'agent::event::*',     payload: { /* event */ } }

// From Frontend
{ type: 'frontend::register',  payload: { /* ... */ } }
{ type: 'frontend::startGoal', payload: { goal } }

// To BSM
{ type: 'bsm::registerAck',     payload: { /* ack */ } }
{ type: 'coordinator::agentCommand',   payload: { agentId, taskId, task, completionCondition } }
{ type: 'coordinator::cancelTask',     payload: { agentId, taskId } }
{ type: 'coordinator::spawnAgent',     payload: { /* ... */ } }
{ type: 'coordinator::terminateAgent', payload: { agentId } }
```

**Command acknowledgment flow:**
1. Coordinator sends `coordinator::agentCommand`; the agent is marked `pending` with a ~10s ack timeout.
2. BSM forwards the command to the agent over TCP.
3. The agent immediately replies with a command ack (accepted / rejected) before executing.
4. BSM relays it upstream as `agent::commandAck`.
5. On accept → agent becomes `busy`; on reject or ack timeout → agent returns to `idle`/`unknown` and the
   Coordinator replans.

### Bot Server Manager

**Purpose:** Agent lifecycle manager and message router

**Key Features:**
- Spawns/terminates bot agent processes
- WebSocket connection upstream to the Coordinator
- TCP server for bot agents
- Message routing with a bounded outbound FIFO queue (never silently drops; logs on cap)
- Optional shared-secret validation for agent registration
- Health checks and metrics on the HTTP port (4002)

**Message Routing:**
```
Agent → BSM (TCP) → Coordinator (WebSocket)
Coordinator → BSM (WebSocket) → Agent (TCP)
Agent → BSM → World State (HTTP)
```

**Managed Process Lifecycle:**
1. Coordinator requests an agent spawn (`coordinator::spawnAgent`)
2. BSM forks the bot-agent process
3. Agent connects via TCP and registers (with `authToken` if auth is enabled)
4. BSM marks the agent as "running" and flushes any queued frames
5. Coordinator sends commands via the BSM; the agent acks them
6. Agent reports events/status via the BSM
7. BSM terminates the agent on request (SIGTERM → SIGKILL)

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

### DeepSeek API Errors

**Symptom:**
```
ERROR: Error during Coordinator LLM interaction
WARN: DeepSeek API request failed
```

**Solutions:**
1. Verify `DEEPSEEK_API_KEY` is valid: https://platform.deepseek.com/api_keys
2. Check your account's quota / rate limits for the deepseek-v4-flash model
3. Check DeepSeek API status: https://status.deepseek.com/
4. Inspect Coordinator logs for the specific error and retry behavior

### Agent Not Spawning

**Symptom:**
```
ERROR: Error spawning bot agent process
```

**Solutions:**
1. Check the BSM's `AGENT_SCRIPT_PATH` points to the built file
2. Verify the file exists: `ls packages/bot-agent/dist/index.js`
3. Rebuild if missing: `pnpm --filter @aetherius/bot-agent run build`
4. Confirm `COORDINATOR_ADDRESS` is correct so the BSM can register upstream
5. If `CLUSTER_AUTH_TOKEN` is set, make sure it matches across Coordinator, BSM, and agents

### Agent Can't Connect to Minecraft

**Symptom:**
```
ERROR: Bot agent-001 error: Error: connect ECONNREFUSED
```

**Solutions:**
1. Verify Minecraft server is running
2. Check `MC_HOST` and `MC_PORT` are correct
3. Test connection: `telnet localhost 25565`
4. Check Minecraft allows bot connections (online-mode, whitelist); set `MC_AUTH`/`MC_USERNAME` accordingly
5. Verify Minecraft version matches `MC_VERSION` (1.21.1)

### High Memory Usage

**Symptom:** Service using excessive RAM

**Solutions:**
1. Check for memory leaks in metrics
2. Limit the number of concurrent agents per BSM
3. Restart services periodically
4. Use PM2 `max_memory_restart` option

### Commands Not Being Acknowledged

**Symptom:** Coordinator logs ack timeouts; agents stay `pending` then go back to `idle`

**Solutions:**
1. Confirm the BSM is connected to the Coordinator (`COORDINATOR_ADDRESS`)
2. Confirm the agent is connected over TCP to the BSM (port 4001)
3. Check for `CLUSTER_AUTH_TOKEN` mismatches (rejected registrations)
4. Inspect BSM outbound-queue metrics for drops (`agent_outbound_dropped`)
5. Check agent logs for command-handling errors

---

## Development

### Building Individual Services

```bash
# Build specific service
pnpm --filter @aetherius/coordinator run build

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
pnpm --filter @aetherius/coordinator test -- --watch
```

Tests run on [Vitest](https://vitest.dev/).

### Code Structure

```
Nectar/
├── packages/
│   ├── shared-types/          # Frozen message protocol, config schemas & utilities
│   │   ├── src/
│   │   │   ├── logger.ts      # Winston logger factory
│   │   │   ├── config.ts      # Zod config schemas & validation
│   │   │   ├── protocol*.ts   # Message types, envelopes, parsers, payload schemas
│   │   │   ├── health.ts      # Health check utilities
│   │   │   └── metrics.ts     # Metrics collection
│   │   └── package.json
│   ├── world-state-service/   # World knowledge database + goal board
│   ├── coordinator/           # Conversational AI planner & task dispatcher
│   ├── bot-server-manager/    # Agent lifecycle manager & message router
│   ├── bot-agent/             # Minecraft bot (50ms reactive layer + skill modules)
│   ├── frontend/              # Optional web UI (stub)
│   ├── _archived_orchestrator-service/  # Archived (not built)
│   └── _archived_squad-leader/          # Archived (not built)
├── .env                       # Environment variables
├── ecosystem.config.js        # PM2 configuration
├── start-dev.sh              # Development startup script
├── stop-dev.sh               # Development shutdown script
├── INTEGRATION_STATUS.md     # Historical integration log
└── USER_GUIDE.md             # This file
```

> The exact filenames under `shared-types/src` may vary; the protocol module exports `PROTOCOL_VERSION`,
> `MsgType`, `TcpMsgType`, `parseWsMessage`/`parseTcpMessage`, `makeWsMessage`, `validatePayload`, the Zod
> payload schemas, and `checkAuthToken`.

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
- [ ] DeepSeek API key validated
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
curl http://localhost:5000/health  # Coordinator
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
# - High error rates / LLM failures
# - Command-ack timeouts
# - Memory/CPU usage
```

### Scaling Considerations

**Horizontal Scaling:**
- Run multiple BSM instances with load balancing
- Each BSM manages separate agent pools
- The Coordinator connects to all BSMs

**Vertical Scaling:**
- Coordinator: 1-2 GB RAM
- BSM: 512 MB RAM + 100 MB per agent
- Bot Agent: 100-200 MB RAM each
- World State: 512 MB RAM + MongoDB size

**Cost Optimization:**
- The Coordinator resolves crafting goals deterministically (no LLM tokens spent on recipe expansion)
- DeepSeek deepseek-v4-flash is the model used for the conversational planning loop
- Monitor LLM invocation counts and durations in metrics

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
pm2 logs coordinator

# Restart service
pm2 restart coordinator

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
| Coordinator | 5000 | 5001 | - |
| BSM | 4002 | 4000 | 4001 (agents) |

### Support

- **Documentation**: See README.md
- **Issues**: GitHub Issues
- **Logs**: Check Winston logs for detailed errors
- **Health**: Use `/health` endpoints for diagnostics
- **Metrics**: Use `/metrics` endpoints for performance data

---

## License

MIT License - See LICENSE file for details

---

**Version**: 2.0.0 (architecture overhaul — conversational Coordinator)
**Last Updated**: 2026-06-08
**Status**: Active development
