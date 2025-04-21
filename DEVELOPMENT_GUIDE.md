# Aetherius Development Guide

This guide provides instructions for setting up, building, running, and troubleshooting the Aetherius project in its current development state.

**Note:** As of this guide's creation, the project is functional at the component level but requires further implementation (especially within the Bot Agent modules) and integration testing (Phase 5) before it can achieve complex end-to-end goals autonomously.

## 1. Prerequisites

*   **Node.js:** Version 20.x or later recommended.
*   **pnpm:** Package manager used for the monorepo. Install via `npm install -g pnpm`.
*   **MongoDB:** A running MongoDB instance (local or remote).
*   **Minecraft Server:** A compatible Minecraft server (Java Edition, version matching agent config, e.g., 1.20.1) accessible by the agents. Ensure the server is configured appropriately (e.g., `online-mode=false` if agents don't use Microsoft auth, sufficient view distance).
*   **Google Gemini API Key:** Obtain an API key from Google AI Studio for the Orchestrator and Squad Leader LLM interactions.

## 2. Setup

1.  **Clone the Repository:**
    ```bash
    git clone <repository_url>
    cd aetherius-dragon-ai
    ```
2.  **Install Dependencies:**
    ```bash
    pnpm install
    ```

## 3. Building

Build all packages in the workspace:

```bash
pnpm run build
```

This command runs the `build` script (typically `tsc`) in each package defined in `pnpm-workspace.yaml`.

## 4. Configuration (Environment Variables)

The services rely on environment variables for configuration. You can set these directly in your shell, use a `.env` file with a library like `dotenv` (requires adding `dotenv` dependency and code changes), or use process managers like `pm2` with ecosystem files.

**Required Variables:**

*   **`GEMINI_API_KEY`:** (Needed by Orchestrator & Squad Leader) Your Google Gemini API key.
*   **`MONGO_URI`:** (Needed by World State Service) Your MongoDB connection string (e.g., `mongodb://localhost:27017/aetherius_world_state`).
*   **`MC_HOST`:** (Needed by BSM/Agent) Hostname or IP of your Minecraft server.
*   **`MC_PORT`:** (Needed by BSM/Agent) Port of your Minecraft server (e.g., `25565`).
*   **`MC_VERSION`:** (Needed by BSM/Agent) Minecraft version (e.g., `1.20.1`).

**Optional Variables (Defaults Provided):**

*   **World State Service:**
    *   `PORT`: HTTP port (default: `3000`)
    *   `WS_PORT`: WebSocket port (default: `3001`)
*   **Orchestrator Service:**
    *   `ORCHESTRATOR_PORT`: HTTP port (default: `5000`)
    *   `ORCHESTRATOR_WS_PORT`: WebSocket port (default: `5001`)
    *   `WORLD_STATE_API_ADDRESS`: (default: `http://localhost:3000`) - *Adjust if WSS runs on a different host/port.*
    *   `SQUAD_LEADER_SCRIPT_PATH`: (defaults to relative path) - *Usually okay unless deploying differently.*
*   **Bot Server Manager (BSM):**
    *   `BSM_WS_PORT`: WebSocket port (default: `4000`)
    *   `BSM_AGENT_PORT`: Local TCP port for agents (default: `4001`)
    *   `ORCHESTRATOR_ADDRESS`: (default: `ws://localhost:????`) - **MUST be set correctly**, e.g., `ws://localhost:5001` if Orchestrator uses default WS port.
    *   `WORLD_STATE_API_ADDRESS`: (default: `http://localhost:3000`) - *Adjust if WSS runs on a different host/port.*
    *   `BSM_ID`: (default: `bsm-<random>`) - Useful for identifying logs if running multiple BSMs.
    *   `AGENT_SCRIPT_PATH`: (defaults to relative path) - *Usually okay unless deploying differently.*
*   **Bot Agent:** (Set via BSM environment)
    *   `AGENT_ID`: Set automatically by BSM.
    *   `BSM_TCP_PORT`: Set automatically by BSM.
    *   `BSM_HOST`: (default: `127.0.0.1`) - *Adjust if BSM runs on a different host than the agent.*

**Example `.env` (if using `dotenv`):**

```dotenv
# Required
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
MONGO_URI=mongodb://localhost:27017/aetherius_world_state
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.20.1

# Optional Overrides (Example)
ORCHESTRATOR_WS_PORT=5001
WORLD_STATE_API_ADDRESS=http://localhost:3000
ORCHESTRATOR_ADDRESS=ws://localhost:5001 # For BSM
```

## 5. Running the System

Start the services in separate terminals **in the following order**:

1.  **MongoDB:** Ensure your MongoDB instance is running.
2.  **World State Service:**
    ```bash
    # Set required env vars first (e.g., export MONGO_URI=...)
    pnpm --filter @aetherius/world-state-service start
    ```
    *Watch for:* "MongoDB connected successfully." and "World State Service API listening on port..."
3.  **Bot Server Manager (BSM):**
    ```bash
    # Set required env vars first (e.g., export ORCHESTRATOR_ADDRESS=ws://localhost:5001 ...)
    # Also ensure MC_HOST, MC_PORT, MC_VERSION are set
    pnpm --filter @aetherius/bot-server-manager start
    ```
    *Watch for:* "BSM WebSocket server listening..." and "BSM TCP server listening..."
4.  **Orchestrator Service:**
    ```bash
    # Set required env vars first (e.g., export GEMINI_API_KEY=...)
    pnpm --filter @aetherius/orchestrator-service start
    ```
    *Watch for:* "Orchestrator WebSocket server listening..." and "Orchestrator started. Waiting for connections..."
5.  **(Optional) Frontend:** (If implemented)
    ```bash
    # Assuming a start script exists
    pnpm --filter @aetherius/frontend start
    ```

**Note:** The BSM will not spawn agents automatically yet. Agent spawning is triggered by the Orchestrator via the `orchestrator::spawnAgent` message, which currently needs to be initiated (e.g., through a frontend command or manual trigger).

## 6. Initiating a Goal (Current State)

As the end-to-end flow isn't fully refined, initiating a complex goal like "Beat the Ender Dragon" won't work as intended yet.

*   **Via Frontend (if available):** If the optional frontend service is running and has UI elements to send goals, use those. It likely sends a `frontend::startGoal` message over WebSocket to the Orchestrator.
*   **Manual Trigger (Development):** You might need to manually send a WebSocket message of type `frontend::startGoal` with a payload like `{ "goal": "Gather 10 wood" }` to the Orchestrator's WebSocket port (default 5001) using a WebSocket client tool.

The Orchestrator should then (ideally):
1.  Receive the goal.
2.  Run strategic planning (LLM call).
3.  Call `delegateTaskToSquad`.
4.  Spawn a Squad Leader process.
5.  The Squad Leader connects back, receives `init`.
6.  Squad Leader runs tactical planning (LLM call).
7.  Squad Leader sends `agentCommandBatch` to the Orchestrator (which should forward it to the correct BSM - **Note:** BSM needs Orchestrator WS address).
8.  BSM receives command, spawns agent if needed, and relays command via TCP.
9.  Agent executes the command (currently limited by skeleton module implementations).

## 7. Monitoring

*   Check the console output of each running service terminal for logs, status messages, and errors.
*   Use tools like `mongosh` or MongoDB Compass to inspect the `aetherius_world_state` database (collections: `pois`, `resourcenodes`, `infrastructures`).

## 8. Basic Troubleshooting

*   **Service Won't Start:**
    *   Check if `pnpm run build` completed successfully for that package.
    *   Verify all required environment variables are set correctly for that service.
    *   Check if the required ports are already in use by another application.
*   **Connection Errors (WS/TCP):**
    *   Double-check configured addresses and ports (`ORCHESTRATOR_ADDRESS` in BSM, `BSM_HOST`/`BSM_TCP_PORT` in Agent, etc.).
    *   Ensure the target service is running and listening on the correct port.
    *   Check firewalls.
*   **MongoDB Errors (World State Service):**
    *   Ensure the MongoDB server is running.
    *   Verify the `MONGO_URI` is correct (including database name, credentials if needed).
*   **Gemini API Key Errors:**
    *   Ensure `GEMINI_API_KEY` is set correctly in the environment for Orchestrator and Squad Leader processes.
    *   Check for typos or invalid characters in the key.
*   **Minecraft Connection Errors (Agent Logs):**
    *   Verify `MC_HOST`, `MC_PORT`, `MC_VERSION` match the target server.
    *   Check Minecraft server logs for connection attempts/errors.
    *   Ensure the server is running and accessible from where the agent is running.
    *   Check authentication requirements (`online-mode`, Microsoft auth).
*   **LLM Planning Issues:**
    *   Check Orchestrator/Squad Leader logs for errors during `runStrategicPlanning` or `runTacticalPlanning`.
    *   Look for errors related to API calls, prompt construction, or tool execution.
*   **Agent Not Spawning:**
    *   Ensure the BSM receives the `orchestrator::spawnAgent` command from the Orchestrator.
    *   Check BSM logs for errors during the `fork` process.
    *   Verify the `AGENT_SCRIPT_PATH` is correct relative to the BSM's `dist` directory.
*   **Squad Leader Not Spawning:**
    *   Ensure the Orchestrator receives the `delegateTaskToSquad` call from the LLM.
    *   Check Orchestrator logs for errors during the `fork` process.
    *   Verify the `SQUAD_LEADER_SCRIPT_PATH` is correct relative to the Orchestrator's `dist` directory.

This guide reflects the project's current state. As development progresses (especially Bot Agent refinement and integration testing), these instructions will need updates.