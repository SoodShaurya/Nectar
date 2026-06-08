# syntax=docker/dockerfile:1
# Multi-stage build for @aetherius/coordinator.
#
# IMPORTANT: the build context MUST be the repo root (pnpm workspace; depends on
# @aetherius/shared-types via workspace:*).

# ---------- builder ----------
FROM node:20-slim AS builder
WORKDIR /app
# Run pnpm non-interactively (no TTY in the build) so the --prod prune below
# does not abort on its node_modules purge confirmation.
ENV CI=true

# Enable corepack-managed pnpm.
RUN corepack enable

# Copy workspace manifests first for better layer caching of the install step.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy the shared library and the target package.
COPY packages/shared-types ./packages/shared-types
COPY packages/coordinator ./packages/coordinator

# Install all workspace dependencies (dev deps included; tsc needs them).
RUN pnpm install --frozen-lockfile

# Build shared-types first (project reference), then the coordinator.
RUN pnpm --filter @aetherius/shared-types run build \
 && pnpm --filter @aetherius/coordinator run build

# Prune to production-only dependencies in place (keeps the pnpm symlink layout).
RUN pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:20-slim AS runtime
ENV NODE_ENV=production

# Copy the whole built workspace tree as one unit so pnpm's internal symlinks
# remain valid.
COPY --from=builder /app /app

WORKDIR /app/packages/coordinator
# COORDINATOR_PORT (HTTP) and COORDINATOR_WS_PORT (BSM/frontend WebSocket).
EXPOSE 5000 5001

CMD ["node", "dist/index.js"]
