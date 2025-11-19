# AETHERIUS 🌌

**Autonomous Minecraft Agent Swarm powered by Google Gemini AI**

An ambitious multi-agent system designed to autonomously complete complex objectives in Minecraft, starting with the ultimate goal: **Beat the Ender Dragon**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🎯 Overview

Aetherius is a distributed, collaborative multi-agent system that uses:
- **Strategic AI Planning** (Gemini 1.5 Pro) for high-level objectives
- **Tactical AI Coordination** (Gemini 1.5 Flash) for squad-level execution
- **Autonomous Agents** (Mineflayer) for in-game actions
- **Shared World Knowledge** (MongoDB) for strategic memory
- **Real-time Communication** (WebSockets) for coordination

## 🏗️ Architecture

```
┌─────────────┐
│  Frontend   │ (Optional)
│   (WebUI)   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│   Orchestrator Service          │ ◄─── Gemini 1.5 Pro (Strategic Planning)
│   - Strategic Planning          │
│   - Squad Management            │
│   - Global Coordination         │
└────────┬────────────────────────┘
         │ spawns
         ├──────────────┬──────────────┐
         ▼              ▼              ▼
    ┌─────────┐   ┌─────────┐   ┌─────────┐
    │ Squad   │   │ Squad   │   │ Squad   │ ◄─── Gemini 1.5 Flash (Tactical)
    │ Leader  │   │ Leader  │   │ Leader  │
    └────┬────┘   └────┬────┘   └────┬────┘
         │             │             │
         └─────────────┼─────────────┘
                       ▼
         ┌──────────────────────────┐
         │ Bot Server Manager (BSM) │
         │  - Agent Lifecycle       │
         │  - Message Routing       │
         └────────┬─────────────────┘
                  │ spawns & manages
         ┌────────┼─────────┬────────┐
         ▼        ▼         ▼        ▼
    ┌────────┐┌────────┐┌────────┐┌────────┐
    │ Agent  ││ Agent  ││ Agent  ││ Agent  │ ◄─── Mineflayer (Minecraft Bots)
    │   #1   ││   #2   ││   #3   ││   #N   │
    └────────┘└────────┘└────────┘└────────┘
         │        │         │        │
         └────────┴─────────┴────────┘
                  │
                  ▼
    ┌──────────────────────────────┐
    │ World State Service          │ ◄─── MongoDB (Strategic Memory)
    │  - POIs, Resources           │
    │  - Infrastructure            │
    └──────────────────────────────┘
```

## 📦 Packages

- **`orchestrator-service`** - Strategic AI planner and squad coordinator
- **`squad-leader`** - Tactical AI commander for agent squads
- **`bot-agent`** - Individual Minecraft bot with modular capabilities
- **`bot-server-manager`** - Agent lifecycle and message routing
- **`world-state-service`** - Persistent world knowledge (MongoDB + API)
- **`shared-types`** - Common TypeScript types and utilities
- **`pathfinder`** - Advanced A* pathfinding for Minecraft
- **`combat`** - PvP combat system (bow & sword)
- **`mineflayer-core`** - Custom Mineflayer build
- **`frontend`** - Optional web UI (basic implementation)

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 20.x
- **pnpm** ≥ 8.x (`npm install -g pnpm`)
- **MongoDB** (local or cloud)
- **Minecraft Server** (Java Edition, version 1.20.1 recommended)
- **Google Gemini API Key** ([Get one here](https://makersuite.google.com/app/apikey))

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
- `GEMINI_API_KEY` - Your Google Gemini API key
- `MONGO_URI` - MongoDB connection string
- `MC_HOST`, `MC_PORT`, `MC_VERSION` - Minecraft server details

### Running the System

Start services in this order:

```bash
# Terminal 1: MongoDB (if running locally)
mongod --dbpath /path/to/data

# Terminal 2: World State Service
pnpm --filter @aetherius/world-state-service start

# Terminal 3: Bot Server Manager
pnpm --filter @aetherius/bot-server-manager start

# Terminal 4: Orchestrator
pnpm --filter @aetherius/orchestrator-service start
```

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
pnpm --filter @aetherius/orchestrator-service run watch
```

### Lint
```bash
pnpm run lint
```

## 📊 Current Status

### ✅ Completed
- ✅ Core architecture implemented
- ✅ TypeScript monorepo structure
- ✅ WebSocket communication system
- ✅ Agent lifecycle management
- ✅ World State Service with MongoDB
- ✅ LLM integration (Gemini Pro & Flash)
- ✅ Advanced pathfinding
- ✅ Combat system (PvP)
- ✅ Configuration validation
- ✅ Logging infrastructure
- ✅ Error handling & retry logic
- ✅ Health checks
- ✅ Circuit breakers
- ✅ Rate limiting
- ✅ Metrics collection
- ✅ LLM response caching

### 🚧 In Progress
- 🚧 Bot agent module implementations (exploration, mining, crafting)
- 🚧 LLM prompt engineering and refinement
- 🚧 End-to-end integration testing
- 🚧 State persistence for agents
- 🚧 Advanced squad coordination

### 📋 Roadmap
- Add unit and integration tests
- Implement advanced building system
- Add more sophisticated agent roles
- Improve error recovery mechanisms
- Add web UI for monitoring
- Performance optimizations
- Multi-server support

## 🏃‍♂️ Usage Examples

### Manual Testing

1. **Start the system** (all services running)
2. **Trigger a goal** via Frontend or manual WebSocket message:
   ```json
   {
     "type": "frontend::startGoal",
     "payload": { "goal": "Gather 10 wood logs" }
   }
   ```
3. **Monitor logs** to see the orchestrator plan, squad formation, and agent execution

### Monitoring

- **Orchestrator**: Check strategic planning and squad management
- **Squad Leaders**: Monitor tactical decisions and agent commands
- **Agents**: Watch task execution and perception reports
- **World State**: Query `http://localhost:3000/query` for stored data

### Health Checks

Each service exposes a health endpoint (when implemented):
- World State Service: `http://localhost:3000/health`
- Orchestrator: `http://localhost:5000/health`
- BSM: `http://localhost:4000/health`

## 🐛 Troubleshooting

### Service Won't Start
```bash
# Check if all packages built successfully
pnpm run build

# Verify environment variables
cat .env

# Check if ports are available
lsof -i :3000 # World State
lsof -i :4000 # BSM
lsof -i :5001 # Orchestrator WS
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
- Verify ORCHESTRATOR_ADDRESS is correct
- Check that agent script path is valid
- Ensure MC_HOST/PORT/VERSION are correct

### LLM Errors
- Verify GEMINI_API_KEY is valid
- Check rate limits (60 calls/minute for Pro, 1500/minute for Flash)
- Monitor circuit breaker state in logs

## 📚 Documentation

- [Development Guide](./DEVELOPMENT_GUIDE.md) - Detailed setup and development instructions
- [Architecture Plan](./AETHERIUS_PLAN.md) - Complete system design and roadmap
- [Pathfinder API](./packages/pathfinder/docs/API.md) - Pathfinding documentation
- [Combat API](./packages/combat/src/sword/API.md) - Combat system documentation

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
- [Google Gemini](https://deepmind.google/technologies/gemini/) - AI planning
- Original pathfinding implementation by GenerelSchwerz
- Combat system by nxg-org

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/SoodShaurya/Nectar/issues)
- **Discussions**: [GitHub Discussions](https://github.com/SoodShaurya/Nectar/discussions)

---

**⚠️ Note**: This project is in active development. The system is functional at the component level but requires further implementation and testing to achieve complex end-to-end goals autonomously.

**Goal**: Beat the Ender Dragon 🐉 → 🏆
