import { z } from 'zod';

// Helper to create number from string with default
const numberFromString = (defaultValue: string) =>
  z.string().regex(/^\d+$/).default(defaultValue).transform(Number);

// Coordinator Configuration Schema (replaces the former orchestrator + squad leader tiers)
export const coordinatorConfigSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY is required'),
  // Which DeepSeek model the coordinator reasons with. Restricted to v4 variants
  // (e.g. deepseek-v4-pro for deepest planning, deepseek-v4-flash for ~2x lower
  // latency). Flip without a code change.
  COORDINATOR_MODEL: z
    .string()
    .regex(/^deepseek-v4-/, 'COORDINATOR_MODEL must be a deepseek-v4-* variant')
    .default('deepseek-v4-flash'),
  COORDINATOR_PORT: numberFromString('5000'),
  COORDINATOR_WS_PORT: numberFromString('5001'),
  WORLD_STATE_API_ADDRESS: z.string().url().default('http://localhost:3000'),
  MC_VERSION: z.string().default('1.21.1'),
  // Optional shared secret. When set, BSMs must present a matching token to
  // register. Leave unset to disable auth (local dev).
  CLUSTER_AUTH_TOKEN: z.string().optional(),
  // Comma-separated usernames seeding the in-game chat whitelist. When
  // non-empty the whitelist defaults to enabled (only listed players may
  // command the swarm via in-game chat). Editable at runtime from the web UI.
  COORDINATOR_CHAT_WHITELIST: z.string().optional(),
});

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;

// Bot Server Manager Configuration Schema
export const bsmConfigSchema = z.object({
  BSM_WS_PORT: numberFromString('4000'),
  BSM_AGENT_PORT: numberFromString('4001'),
  // Upstream coordinator WebSocket address. ORCHESTRATOR_ADDRESS is a
  // deprecated alias kept for backward compatibility — prefer COORDINATOR_ADDRESS.
  COORDINATOR_ADDRESS: z.string().url().optional(),
  ORCHESTRATOR_ADDRESS: z.string().url().optional(),
  WORLD_STATE_API_ADDRESS: z.string().url().default('http://localhost:3000'),
  BSM_ID: z.string().optional(),
  AGENT_SCRIPT_PATH: z.string().optional(),
  MC_HOST: z.string().default('localhost'),
  MC_PORT: numberFromString('25565'),
  MC_VERSION: z.string().default('1.21.1'),
  // Optional shared secret presented to the coordinator and required from agents.
  CLUSTER_AUTH_TOKEN: z.string().optional(),
});

export type BsmConfig = z.infer<typeof bsmConfigSchema>;

// Bot Agent Configuration Schema
export const agentConfigSchema = z.object({
  AGENT_ID: z.string().optional(),
  BSM_TCP_PORT: numberFromString('4001'),
  BSM_HOST: z.string().default('127.0.0.1'),
  MC_HOST: z.string().default('localhost'),
  MC_PORT: numberFromString('25565'),
  MC_VERSION: z.string().default('1.21.1'),
  MC_AUTH: z.enum(['microsoft', 'offline']).default('offline'),
  MC_USERNAME: z.string().optional(), // Microsoft email for online-mode servers
  // Optional shared secret presented to the BSM on TCP registration.
  CLUSTER_AUTH_TOKEN: z.string().optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// World State Service Configuration Schema
export const worldStateConfigSchema = z.object({
  PORT: numberFromString('3000'),
  WS_PORT: numberFromString('3001'),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
});

export type WorldStateConfig = z.infer<typeof worldStateConfigSchema>;

/**
 * Validates configuration and returns typed config object
 * Exits process if validation fails
 */
export function validateConfig<T>(
  schema: z.ZodSchema<T>,
  serviceName: string
): T {
  const result = schema.safeParse(process.env);

  if (!result.success) {
    console.error(`❌ Configuration validation failed for ${serviceName}:`);
    result.error.issues.forEach((issue) => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }

  return result.data;
}
