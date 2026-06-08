# Aetherius Development Guide

This guide provides instructions for setting up, building, running, and troubleshooting the Aetherius project.

**Architecture note:** Aetherius is built around a single conversational **Coordinator** (Gemini 3 Flash via
`@google/genai`) that manages a MongoDB-persisted goal board and dispatches tasks directly to agents through
the Bot Server Manager (BSM). The earlier Orchestrator + Squad Leader tiers have been removed; those packages
are archived under `packages/_archived_*`. See [README.md](./README.md) for the full architecture.

## 1. Prerequisites

*   **Node.js:** Version 20.x or later required.
*   **pnpm:** Package manager used for the monorepo. Install via `npm install -g pnpm`.
*   **MongoDB:** A running MongoDB instance (local or remote).
*   **Minecraft Server:** A compatible Minecraft server (Java Edition, version 1.21.1) accessible by the agents. Ensure the server is configured appropriately (e.g., `online-mode=false` if agents use offline auth, sufficient view distance).
*   **Google Gemini API Key:** Obtain an API key from Google AI Studio for the Coordinator's LLM interactions.

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

This command runs the `build` script (typically `tsc`) in each active package defined in
`pnpm-workspace.yaml`. The archived packages under `packages/_archived_*` are excluded from the build.

**Tests** run on Vitest:

```bash
pnpm test
```

## 4. Configuration (Environment Variables)

The services rely on environment variables for configuration. You can set these directly in your shell, use a `.env` file with a library like `dotenv` (requires adding `dotenv` dependency and code changes), or use process managers like `pm2` with ecosystem files.

**Required Variables:**

*   **`GEMINI_API_KEY`:** (Needed by Coordinator) Your Google Gemini API key.
*   **`MONGO_URI`:** (Needed by World State Service) Your MongoDB connection string (e.g., `mongodb://localhost:27017/aetherius_world_state`).
*   **`MC_HOST`:** (Needed by BSM/Agent) Hostname or IP of your Minecraft server.
*   **`MC_PORT`:** (Needed by BSM/Agent) Port of your Minecraft server (e.g., `25565`).
*   **`MC_VERSION`:** (Needed by Coordinator/BSM/Agent) Minecraft version (default: `1.21.1`).

**Optional Variables (Defaults Provided):**

*   **World State Service:**
    *   `PORT`: HTTP port (default: `3000`)
    *   `WS_PORT`: WebSocket port (default: `3001`)
*   **Coordinator:**
    *   `COORDINATOR_PORT`: HTTP port (default: `5000`)
    *   `COORDINATOR_WS_PORT`: WebSocket port BSMs connect to (default: `5001`)
    *   `WORLD_STATE_API_ADDRESS`: (default: `http://localhost:3000`) - *Adjust if WSS runs on a different host/port.*
    *   `MC_VERSION`: (default: `1.21.1`) - used for crafting recipe data.
    *   `CLUSTER_AUTH_TOKEN`: Optional shared secret BSMs must present to register. Unset = auth disabled.
*   **Bot Server Manager (BSM):**
    *   `BSM_WS_PORT`: Upstream WebSocket port (default: `4000`)
    *   `BSM_AGENT_PORT`: Local TCP port for agents (default: `4001`)
    *   `BSM_HTTP_PORT`: HTTP health/metrics port (default: `4002`)
    *   `COORDINATOR_ADDRESS`: Upstream Coordinator WebSocket address (default: `ws://localhost:5001`). The
        deprecated alias `ORCHESTRATOR_ADDRESS` is still accepted but logs a deprecation warning.
    *   `WORLD_STATE_API_ADDRESS`: (default: `http://localhost:3000`) - *Adjust if WSS runs on a different host/port.*
    *   `BSM_ID`: (default: `bsm-<random>`) - Useful for identifying logs if running multiple BSMs.
    *   `AGENT_SCRIPT_PATH`: (defaults to relative path) - *Usually okay unless deploying differently.*
    *   `MC_HOST` / `MC_PORT` / `MC_VERSION`: Minecraft details passed to spawned agents.
    *   `CLUSTER_AUTH_TOKEN`: Optional shared secret presented upstream and required from agents.
*   **Bot Agent:** (usually spawned by, and configured via, the BSM environment)
    *   `AGENT_ID`: Unique agent identifier.
    *   `BSM_TCP_PORT`: (default: `4001`) BSM TCP port to connect to.
    *   `BSM_HOST`: (default: `127.0.0.1`) - *Adjust if the BSM runs on a different host than the agent.*
    *   `MC_AUTH`: `offline` (default) or `microsoft` (set `MC_USERNAME` for online-mode servers).
    *   `CLUSTER_AUTH_TOKEN`: Optional shared secret presented to the BSM on registration.

**Example `.env` (if using `dotenv`):**

```dotenv
# Required
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
MONGO_URI=mongodb://localhost:27017/aetherius_world_state
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.21.1

# Optional Overrides (Example)
COORDINATOR_WS_PORT=5001
WORLD_STATE_API_ADDRESS=http://localhost:3000
COORDINATOR_ADDRESS=ws://localhost:5001   # For BSM upstream connection
# CLUSTER_AUTH_TOKEN=your-shared-secret    # Set the SAME value across all services to enable auth
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
    # Set required env vars first (e.g., export COORDINATOR_ADDRESS=ws://localhost:5001 ...)
    # Also ensure MC_HOST, MC_PORT, MC_VERSION are set
    pnpm --filter @aetherius/bot-server-manager start
    ```
    *Watch for:* "BSM WebSocket server listening..." and "BSM TCP server listening..."
4.  **Coordinator:**
    ```bash
    # Set required env vars first (e.g., export GEMINI_API_KEY=...)
    pnpm --filter @aetherius/coordinator start
    ```
    *Watch for:* "Coordinator WebSocket server started" and "Coordinator HTTP server listening..."
5.  **(Optional) Frontend:** (stub)
    ```bash
    pnpm --filter @aetherius/frontend start
    ```

**Note:** Agent spawning is triggered by the Coordinator via the `coordinator::spawnAgent` message (and/or
the BSM's own configuration), which is initiated as part of working a goal — through a frontend command or a
manual `frontend::startGoal` trigger.

## 6. Initiating a Goal

*   **Via Frontend (if available):** If the optional frontend service is running and has UI elements to send goals, use those. It sends a `frontend::startGoal` message over WebSocket to the Coordinator.
*   **Manual Trigger (Development):** Send a WebSocket message of type `frontend::startGoal` with a payload like `{ "goal": "Gather 10 wood" }` to the Coordinator's WebSocket port (default 5001) using a WebSocket client tool.

The Coordinator then:
1.  Receives the goal and adds it to the MongoDB-persisted goal board.
2.  Runs its conversational planning loop (Gemini 3 Flash). Crafting sub-goals are expanded deterministically
    into task-trees without spending LLM tokens.
3.  Dispatches a task to a chosen agent as `coordinator::agentCommand` (marking the agent `pending`).
4.  The BSM forwards the command to the agent over TCP; the agent immediately acks it.
5.  The BSM relays the ack upstream as `agent::commandAck`; on acceptance the Coordinator marks the agent
    `busy`, and on rejection/timeout it returns the agent to `idle` and replans.
6.  The agent executes the task and reports events/status back through the BSM; discoveries are persisted to
    the World State Service.

## 7. Monitoring

*   Check the console output of each running service terminal for logs, status messages, and errors.
*   Use tools like `mongosh` or MongoDB Compass to inspect the `aetherius_world_state` database (collections: `pois`, `resourcenodes`, `infrastructures`).

## 8. Basic Troubleshooting

*   **Service Won't Start:**
    *   Check if `pnpm run build` completed successfully for that package.
    *   Verify all required environment variables are set correctly for that service.
    *   Check if the required ports are already in use by another application.
*   **Connection Errors (WS/TCP):**
    *   Double-check configured addresses and ports (`COORDINATOR_ADDRESS` in BSM, `BSM_HOST`/`BSM_TCP_PORT` in Agent, etc.).
    *   Ensure the target service is running and listening on the correct port.
    *   If `CLUSTER_AUTH_TOKEN` is set, ensure it matches across the Coordinator, BSM, and agents — a mismatch causes the connection/registration to be rejected.
    *   Check firewalls.
*   **MongoDB Errors (World State Service):**
    *   Ensure the MongoDB server is running.
    *   Verify the `MONGO_URI` is correct (including database name, credentials if needed).
*   **Gemini API Key Errors:**
    *   Ensure `GEMINI_API_KEY` is set correctly in the Coordinator's environment.
    *   Check for typos or invalid characters in the key.
*   **Minecraft Connection Errors (Agent Logs):**
    *   Verify `MC_HOST`, `MC_PORT`, `MC_VERSION` match the target server.
    *   Check Minecraft server logs for connection attempts/errors.
    *   Ensure the server is running and accessible from where the agent is running.
    *   Check authentication requirements (`online-mode`, `MC_AUTH`/`MC_USERNAME`).
*   **LLM Planning Issues:**
    *   Check the Coordinator logs for errors during its planning loop.
    *   Look for errors related to API calls, prompt construction, or tool execution.
*   **Agent Not Spawning:**
    *   Ensure the BSM is connected upstream to the Coordinator (`COORDINATOR_ADDRESS`).
    *   Check BSM logs for errors during the `fork` process.
    *   Verify the `AGENT_SCRIPT_PATH` is correct relative to the BSM's `dist` directory.
*   **Commands Not Acknowledged:**
    *   Confirm the agent is connected over TCP to the BSM (port 4001).
    *   Watch for ack timeouts in the Coordinator logs (agent stuck `pending` then returned to `idle`).
    *   Check BSM outbound-queue metrics for drops (`agent_outbound_dropped`).

This guide reflects the current (post-overhaul) architecture. As development progresses (especially Bot Agent
module refinement and integration testing), these instructions will be updated.