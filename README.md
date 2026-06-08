# AETHERIUS 🌌

**Autonomous Minecraft Agent Swarm powered by DeepSeek AI**

An ambitious multi-agent system designed to autonomously complete complex objectives in Minecraft, starting with the ultimate goal: **Beat the Ender Dragon**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🎯 Overview

Aetherius is a distributed system built around a single conversational **Coordinator** that uses:
- **Conversational AI Planning** (DeepSeek `deepseek-v4-flash` via the OpenAI-compatible SDK) that manages a goal board and dispatches tasks
- **Deterministic Crafting Resolution** that expands crafting goals into task-trees without spending LLM tokens
- **Autonomous Agents** (Mineflayer) with a 50ms reactive behavior layer plus skill modules for in-game actions
- **Shared World Knowledge** (MongoDB) for the goal board, POIs, resources, and infrastructure
- **Versioned, Validated Messaging** (WebSockets + TCP) for coordination across services

## 🏗️ Architecture

The earlier three-tier design (Orchestrator + Squad Leaders + Agents) has been replaced by a single
conversational Coordinator. The Coordinator talks to one or more Bot Server Managers (BSMs), each of which
spawns and supervises Minecraft bot-agent processes.

```
┌─────────────┐
│  Frontend   │ (stub: starts goals, monitors)
│   (WebUI)   │
└──────┬──────┘
       │ frontend::startGoal (WS)
       ▼
┌──────────────────────────────────────────────┐
│   Coordinator                                 │ ◄─── DeepSeek deepseek-v4-flash (OpenAI-compatible API)
│   - Conversational planning                   │
│   - MongoDB-persisted goal board              │
│   - Deterministic crafting task-trees         │
│   - Dispatches tasks directly to agents       │
└───────┬──────────────────────────────┬────────┘
        │ WS (coordinator::agentCommand)│ HTTP query/persist
        ▼                               ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│ Bot Server Manager (BSM) │   │ World State Service           │ ◄─── MongoDB
│  - Spawns/supervises      │   │  - Goal board                 │
│    bot-agent processes    │   │  - POIs, resources            │
│  - Routes WS <-> TCP      │   │  - Infrastructure             │
│  - Bounded outbound queue │   └──────────────────────────────┘
└────────┬─────────────────┘                ▲
         │ TCP (command/event/ack)           │ HTTP reports
         ┌────────┼─────────┬────────┐       │
         ▼        ▼         ▼        ▼       │
    ┌────────┐┌────────┐┌────────┐┌────────┐ │
    │ Agent  ││ Agent  ││ Agent  ││ Agent  │─┘ ◄─ Mineflayer + 50ms reactive layer
    │   #1   ││   #2   ││   #3   ││   #N   │
    └────────┘└────────┘└────────┘└────────┘
```

Inter-service messages are **versioned and schema-validated** (see `@aetherius/shared-types`). Commands are
**acknowledged**: the Coordinator marks an agent `pending` until the agent's ack is relayed back by the BSM,
then `busy`. An optional shared secret (`CLUSTER_AUTH_TOKEN`) can be required for BSM and agent registration.

## 📦 Packages

Active packages:
- **`coordinator`** - Conversational planner; goal board, crafting task-trees, task dispatch (DeepSeek deepseek-v4-flash)
- **`bot-agent`** - Mineflayer bot with a 50ms reactive behavior layer and skill modules
- **`bot-server-manager`** - Spawns/supervises bot-agents; routes messages (WS ⇄ TCP)
- **`world-state-service`** - Persistent world knowledge and goal board (MongoDB + API)
- **`shared-types`** - Frozen message protocol, config schemas, and shared utilities
- **`frontend`** - Optional web UI (stub)

Archived (no longer built; under `packages/_archived_*`):
- **`_archived_orchestrator-service`** - Former Gemini Pro strategic planner
- **`_archived_squad-leader`** - Former Gemini Flash tactical commander

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 20.x
- **pnpm** ≥ 8.x (`npm install -g pnpm`)
- **MongoDB** (local or cloud)
- **Minecraft Server** (Java Edition, version 1.21.1)
- **DeepSeek API Key** ([Get one here](https://platform.deepseek.com/api_keys))

### Installation

```bash
# Clone the repository
git clone <repository_url>
cd aetherius-dragon-ai

# Install dependencies
pnpm install

# Build all packages
pnpm run build
```

### Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

**Required environment variables:**
- `DEEPSEEK_API_KEY` - Your DeepSeek API key (Coordinator)
- `MONGO_URI` - MongoDB connection string (World State Service)
- `MC_HOST`, `MC_PORT`, `MC_VERSION` - Minecraft server details (BSM / bot-agent)

**Optional:**
- `CLUSTER_AUTH_TOKEN` - Shared secret. When set on the Coordinator, BSMs must present a matching token to
  register; when set on a BSM, agents must present a matching token. Leave unset to disable auth for local dev.

### Running the System

Start services in this order:

```bash
# Terminal 1: MongoDB (if running locally)
mongod --dbpath /path/to/data

# Terminal 2: World State Service
pnpm --filter @aetherius/world-state-service start

# Terminal 3: Bot Server Manager (BSM)
pnpm --filter @aetherius/bot-server-manager start

# Terminal 4: Coordinator
pnpm --filter @aetherius/coordinator start
```

The Coordinator listens for BSM WebSocket connections; each BSM connects upstream to the Coordinator
(`COORDINATOR_ADDRESS`, default `ws://localhost:5001`) and spawns bot-agents on demand.

## 🛠️ Development

### Build all packages
```bash
pnpm run build
```

### Watch mode (auto-rebuild)
```bash
# In separate terminals
pnpm --filter @aetherius/shared-types run watch
pnpm --filter @aetherius/bot-agent run watch
pnpm --filter @aetherius/coordinator run watch
```

### Lint
```bash
pnpm run lint
```

## 📊 Current Status

### ✅ Completed
- ✅ Architecture overhaul: single conversational Coordinator (DeepSeek deepseek-v4-flash)
- ✅ TypeScript monorepo structure
- ✅ Frozen, versioned, schema-validated message protocol (shared-types)
- ✅ Command acknowledgment flow (pending → busy via agent ack)
- ✅ MongoDB-persisted goal board
- ✅ Deterministic crafting task-tree resolution
- ✅ Agent lifecycle management (BSM spawns/supervises bot-agents)
- ✅ World State Service with MongoDB
- ✅ Bot-agent 50ms reactive behavior layer + skill modules
- ✅ Optional shared-secret auth (`CLUSTER_AUTH_TOKEN`)
- ✅ Bounded outbound queues (no silent message drops)
- ✅ Configuration validation, logging, health checks, metrics

### 🚧 In Progress
- 🚧 Bot agent module implementations (exploration, mining, crafting)
- 🚧 LLM prompt engineering and refinement
- 🚧 End-to-end integration testing
- 🚧 Frontend UI build-out

### 📋 Roadmap
- Add more unit and integration tests
- Implement advanced building system
- Improve error recovery mechanisms
- Build out web UI for monitoring
- Performance optimizations
- Multi-server support

## 🏃‍♂️ Usage Examples

### Manual Testing

1. **Start the system** (all services running)
2. **Trigger a goal** via the Frontend or a manual WebSocket message to the Coordinator (WS port 5001):
   ```json
   {
     "type": "frontend::startGoal",
     "payload": { "goal": "Gather 10 wood logs" }
   }
   ```
3. **Monitor logs** to see the Coordinator plan, update the goal board, and dispatch tasks to agents

### Monitoring

- **Coordinator**: Check conversational planning, goal-board updates, and task dispatch
- **BSM**: Monitor agent spawn/supervision and message routing
- **Agents**: Watch task execution and perception reports
- **World State**: Query `http://localhost:3000/query` for stored data

### Health Checks

Each service exposes a health endpoint:
- World State Service: `http://localhost:3000/health`
- Coordinator: `http://localhost:5000/health`
- BSM: `http://localhost:4002/health`

## 🐛 Troubleshooting

### Service Won't Start
```bash
# Check if all packages built successfully
pnpm run build

# Verify environment variables
cat .env

# Check if ports are available
lsof -i :3000 # World State HTTP
lsof -i :4001 # BSM TCP (agents)
lsof -i :4002 # BSM HTTP (health/metrics)
lsof -i :5001 # Coordinator WS
```

### MongoDB Connection Issues
```bash
# Verify MongoDB is running
mongosh

# Test connection string
mongosh "mongodb://localhost:27017/aetherius_world_state"
```

### Minecraft Connection Issues
```bash
# Verify server is running and accessible
telnet localhost 25565

# Check MC version matches
# Check auth requirements (online-mode in server.properties)
```

### Agent Not Spawning
- Check BSM logs for spawn errors
- Verify the BSM's `COORDINATOR_ADDRESS` is correct (default `ws://localhost:5001`)
- Check that the agent script path (`AGENT_SCRIPT_PATH`) is valid
- Ensure MC_HOST/PORT/VERSION are correct
- If `CLUSTER_AUTH_TOKEN` is set, ensure it matches between Coordinator, BSM, and agents

### LLM Errors
- Verify DEEPSEEK_API_KEY is valid
- Check DeepSeek API rate limits / quota for your account
- Monitor the Coordinator logs for retries and errors

## 📚 Documentation

- [User Guide](./USER_GUIDE.md) - Operating, monitoring, and deploying the system
- [Development Guide](./DEVELOPMENT_GUIDE.md) - Detailed setup and development instructions
- [Architecture Plan](./AETHERIUS_PLAN.md) - Historical (pre-overhaul) design notes
- [Integration Status](./INTEGRATION_STATUS.md) - Historical (pre-overhaul) integration log

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📝 License

MIT License - see [LICENSE](./LICENSE) for details

## 🙏 Acknowledgments

- [Mineflayer](https://github.com/PrismarineJS/mineflayer) - Minecraft bot framework
- [PrismarineJS](https://github.com/PrismarineJS) - Minecraft protocol libraries
- [DeepSeek](https://www.deepseek.com/) - AI planning
- Original pathfinding implementation by GenerelSchwerz
- Combat system by nxg-org

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/SoodShaurya/Nectar/issues)
- **Discussions**: [GitHub Discussions](https://github.com/SoodShaurya/Nectar/discussions)

---

**⚠️ Note**: This project is in active development. The system is functional at the component level but requires further implementation and testing to achieve complex end-to-end goals autonomously.

**Goal**: Beat the Ender Dragon 🐉 → 🏆
