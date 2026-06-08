# syntax=docker/dockerfile:1
# Multi-stage build for @aetherius/bot-server-manager (BSM).
#
# IMPORTANT: the build context MUST be the repo root (pnpm workspace; depends on
# @aetherius/shared-types via workspace:*).
#
# NOTE: the BSM spawns bot-agent child processes via `fork()` resolving
# ../bot-agent/dist/index.js relative to its own dist dir. The image therefore
# MUST also contain the built bot-agent package and its (mineflayer) deps. We
# build bot-agent here as well.

# ---------- builder ----------
FROM node:20-slim AS builder
WORKDIR /app
# Run pnpm non-interactively (no TTY in the build) so the --prod prune below
# does not abort on its node_modules purge confirmation.
ENV CI=true

# mineflayer / prismarine native-ish deps and node-gyp need build toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Enable corepack-managed pnpm.
RUN corepack enable

# Copy workspace manifests first for better layer caching of the install step.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy shared library, the BSM, and bot-agent (forked at runtime by the BSM).
COPY packages/shared-types ./packages/shared-types
COPY packages/bot-server-manager ./packages/bot-server-manager
COPY packages/bot-agent ./packages/bot-agent

# Install all workspace dependencies (dev deps included; tsc needs them).
RUN pnpm install --frozen-lockfile

# Build shared-types first, then the BSM and the bot-agent it spawns.
RUN pnpm --filter @aetherius/shared-types run build \
 && pnpm --filter @aetherius/bot-agent run build \
 && pnpm --filter @aetherius/bot-server-manager run build

# Prune to production-only dependencies in place (keeps the pnpm symlink layout).
RUN pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:20-slim AS runtime
ENV NODE_ENV=production

# Copy the whole built workspace tree as one unit so pnpm's internal symlinks
# remain valid and bot-agent stays resolvable at ../bot-agent/dist/index.js.
COPY --from=builder /app /app

WORKDIR /app/packages/bot-server-manager
# BSM_WS_PORT (upstream/coordinator listener) and BSM_AGENT_PORT (local TCP for agents).
EXPOSE 4000 4001

CMD ["node", "dist/index.js"]
