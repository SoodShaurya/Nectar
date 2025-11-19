# Integration Status: Utilities → Services

## ✅ COMPLETED

### World State Service
- ✅ Winston logger integrated (replaced all console.log)
- ✅ Config validation with Zod
- ✅ Graceful shutdown handlers
- ✅ Health check endpoint (`GET /health`)
- ✅ Metrics endpoint (`GET /metrics`)
- ✅ Retry logic for MongoDB connection
- ✅ Metrics collection (reports, queries, WebSocket)

## 🚧 IN PROGRESS

### Orchestrator Service
- ✅ Winston logger integrated (replaced all console.log)
- ✅ Config validation with orchestratorConfigSchema
- ✅ Graceful shutdown for WebSocket and Squad Leaders
- ✅ Health check endpoint (`GET /health`)
- ✅ Metrics endpoint (`GET /metrics`)
- ✅ Circuit breaker for Gemini API calls
- ✅ LLM response cache for strategic planning (5 min TTL)
- ✅ Rate limiting for Gemini API (60 calls/minute)
- ✅ Metrics collection (planning cycles, LLM calls, squads, agents)

**Key Integration Points:**
```typescript
// At top of file
import {
  createLogger,
  validateConfig,
  orchestratorConfigSchema,
  createGracefulShutdown,
  CircuitBreaker,
  LLMCache,
  RateLimiter,
  metrics
} from '@aetherius/shared-types';

const logger = createLogger('orchestrator');
const config = validateConfig(orchestratorConfigSchema, 'Orchestrator');

// Circuit breaker for Gemini
const geminiCircuitBreaker = new CircuitBreaker('gemini-api', {
  failureThreshold: 5,
  resetTimeout: 60000,
  onStateChange: (state) => logger.warn('Circuit breaker state changed', { state })
});

// LLM cache
const llmCache = new LLMCache({ ttl: 5 * 60 * 1000 });

// Rate limiter (60 calls/minute for Gemini Pro)
const geminiRateLimiter = new RateLimiter({
  maxCalls: 60,
  windowMs: 60000
});

// In runStrategicPlanning function
async function runStrategicPlanning() {
  // Check cache first
  const cacheKey = llmCache.getCacheKey(prompt, context);
  const cached = llmCache.get(cacheKey);
  if (cached) {
    logger.debug('Using cached LLM response');
    return cached;
  }

  // Rate limit
  await geminiRateLimiter.waitIfNeeded();

  // Circuit breaker
  const response = await geminiCircuitBreaker.execute(async () => {
    return await metrics.measureAsync('llm_strategic_call', async () => {
      const result = await strategicChatSession.sendMessage(prompt);
      return result.response.text();
    });
  });

  // Cache response
  llmCache.set(cacheKey, response);
  return response;
}
```

### Bot Server Manager
- ✅ Winston logger integrated (replaced all console.log)
- ✅ Config validation with bsmConfigSchema
- ✅ Graceful shutdown for WebSocket, TCP, HTTP, and agents
- ✅ Health check endpoint (`GET /health` on port 4002)
- ✅ Metrics endpoint (`GET /metrics` on port 4002)
- ✅ Metrics collection (agents, connections, message forwarding, World State reports)

**Key Integration Points:**
```typescript
import {
  createLogger,
  validateConfig,
  bsmConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  metrics
} from '@aetherius/shared-types';

const logger = createLogger('bot-server-manager');
const config = validateConfig(bsmConfigSchema, 'Bot Server Manager');

// Health checks
const healthCheck = new HealthCheck('bot-server-manager', '0.1.0');
healthCheck.registerDependency('orchestrator', async () => {
  // Check WebSocket connection
  return HealthChecks.websocket(orchestratorWS);
});

// Graceful shutdown
const shutdown = createGracefulShutdown(logger);
shutdown.register(async () => {
  logger.info('Terminating all managed agents...');
  for (const [agentId, agent] of managedAgents.entries()) {
    terminateAgent(agentId);
  }
});
```

### Squad Leader
**Needs:**
- [ ] Winston logger (replace ~54 console.log statements)
- [ ] Config validation with squadLeaderConfigSchema
- [ ] Graceful shutdown
- [ ] Circuit breaker for Gemini API
- [ ] LLM cache for tactical planning
- [ ] Rate limiting (1500 calls/minute for Gemini Flash)
- [ ] Metrics collection

**Similar pattern to Orchestrator but for tactical planning**

### Bot Agent
**Needs:**
- [ ] Winston logger (replace ~116 console.log statements)
- [ ] Config validation with agentConfigSchema
- [ ] Graceful shutdown (disconnect from Minecraft/BSM cleanly)
- [ ] Metrics collection for task execution

## 📋 Integration Checklist Per Service

For each service, follow this pattern:

### 1. Import Utilities
```typescript
import {
  createLogger,
  validateConfig,
  [service]ConfigSchema,
  createGracefulShutdown,
  HealthCheck,
  HealthChecks,
  metrics,
  CircuitBreaker, // if calling external APIs
  LLMCache,       // if using LLM
  RateLimiter,    // if calling rate-limited APIs
  retryWithBackoff // if connecting to databases/services
} from '@aetherius/shared-types';
```

### 2. Initialize at Top
```typescript
const logger = createLogger('service-name');
const config = validateConfig(serviceConfigSchema, 'Service Name');

logger.info('Starting service', { config });
```

### 3. Replace All console.log
```bash
# Find and replace pattern:
console.log     → logger.info
console.error   → logger.error
console.warn    → logger.warn
console.debug   → logger.debug
```

### 4. Add Health Check Endpoint
```typescript
const healthCheck = new HealthCheck('service-name', '0.1.0');
healthCheck.registerDependency('dependency-name', checkFunction);

app.get('/health', async (req, res) => {
  const health = await healthCheck.check();
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});
```

### 5. Add Graceful Shutdown
```typescript
const shutdown = createGracefulShutdown(logger);

// Register cleanup handlers (LIFO order)
shutdown.register(async () => {
  logger.info('Closing connections...');
  // Close WebSockets, databases, etc.
});
```

### 6. Add Metrics
```typescript
// Count events
metrics.increment('events_processed');

// Time operations
const startTime = Date.now();
// ... do work ...
metrics.record('operation_time', Date.now() - startTime);

// Or use measureAsync
await metrics.measureAsync('llm_call', async () => {
  return await llmCall();
});
```

### 7. Add Circuit Breakers (for external APIs)
```typescript
const circuitBreaker = new CircuitBreaker('api-name', {
  failureThreshold: 5,
  resetTimeout: 60000
});

const result = await circuitBreaker.execute(async () => {
  return await externalApiCall();
});
```

### 8. Add LLM Caching (for LLM calls)
```typescript
const llmCache = new LLMCache({ ttl: 5 * 60 * 1000 });

const cacheKey = llmCache.getCacheKey(prompt, context);
let response = llmCache.get(cacheKey);

if (!response) {
  response = await llmCall();
  llmCache.set(cacheKey, response);
}
```

### 9. Add Rate Limiting (for APIs)
```typescript
const rateLimiter = new RateLimiter({
  maxCalls: 60,
  windowMs: 60000
});

await rateLimiter.waitIfNeeded();
const result = await apiCall();
```

## 🎯 Priority Order

1. ✅ **World State Service** - DONE
2. **Orchestrator Service** - CRITICAL (circuit breaker + LLM cache = cost savings)
3. **Bot Server Manager** - HIGH (manages all agents)
4. **Squad Leader** - MEDIUM (circuit breaker + LLM cache)
5. **Bot Agent** - LOW (logger + config sufficient)

## 📊 Current Stats

| Service | console.log Count | Lines | Integration % |
|---------|------------------|-------|---------------|
| World State | 0 | 355 | ✅ 100% |
| Orchestrator | 0 | 983 | ✅ 100% |
| BSM | 0 | 627 | ✅ 100% |
| Squad Leader | 54 | 645 | ⏳ 0% |
| Bot Agent | 116 | 1055 | ⏳ 0% |

## 🚀 Quick Integration Script

To speed up integration, you can use this pattern:

```bash
# For each service directory
cd packages/[service]/src

# 1. Find all console.log usage
grep -n "console\." *.ts

# 2. Update imports in index.ts
# Add utilities to imports from @aetherius/shared-types

# 3. Replace console.log with logger
sed -i 's/console\.log(/logger.info(/g' index.ts
sed -i 's/console\.error(/logger.error(/g' index.ts
sed -i 's/console\.warn(/logger.warn(/g' index.ts
sed -i 's/console\.debug(/logger.debug(/g' index.ts

# 4. Add logger initialization at top (manual)
# 5. Add config validation (manual)
# 6. Add shutdown handlers (manual)
# 7. Add health check endpoint (manual)
```

## ✅ Verification

After integration, verify:

```bash
# Build succeeds
pnpm run build

# No console.log remaining
grep -r "console\." packages/*/src/*.ts

# Services start with config validation
# Missing env vars should fail with helpful errors

# Health checks work
curl http://localhost:3000/health  # World State
curl http://localhost:5000/health  # Orchestrator (after integration)
curl http://localhost:4000/health  # BSM (after integration)

# Metrics work
curl http://localhost:3000/metrics

# Graceful shutdown works
# Send SIGTERM, services should close cleanly
```

## 📝 Next Steps

1. Integrate Orchestrator Service (most critical)
2. Integrate BSM
3. Integrate Squad Leader
4. Integrate Bot Agent
5. Test end-to-end
6. Commit all changes

---

**Status**: 3/5 services fully integrated (60%)
**Target**: 5/5 services integrated (100%)

## 📈 Integration Progress

### ✅ Completed (3/5)
1. **World State Service** - Full integration with health checks, metrics, graceful shutdown
2. **Orchestrator Service** - Full integration with circuit breaker, LLM cache, rate limiting, health checks, metrics
3. **Bot Server Manager** - Full integration with health checks, metrics, graceful shutdown, WebSocket/TCP routing

### 🚧 Remaining (2/5)
4. **Squad Leader** - Next priority (circuit breaker + LLM cache needed)
5. **Bot Agent** - Lower priority (logger + config sufficient)
