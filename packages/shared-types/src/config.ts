import { z } from 'zod';

// Helper to create number from string with default
const numberFromString = (defaultValue: string) =>
  z.string().regex(/^\d+$/).default(defaultValue).transform(Number);

// Orchestrator Configuration Schema
export const orchestratorConfigSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  ORCHESTRATOR_PORT: numberFromString('5000'),
  ORCHESTRATOR_WS_PORT: numberFromString('5001'),
  WORLD_STATE_API_ADDRESS: z.string().url().default('http://localhost:3000'),
  SQUAD_LEADER_SCRIPT_PATH: z.string().optional(),
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

// Bot Server Manager Configuration Schema
export const bsmConfigSchema = z.object({
  BSM_WS_PORT: numberFromString('4000'),
  BSM_AGENT_PORT: numberFromString('4001'),
  ORCHESTRATOR_ADDRESS: z.string().url().default('ws://localhost:5001'),
  WORLD_STATE_API_ADDRESS: z.string().url().default('http://localhost:3000'),
  BSM_ID: z.string().optional(),
  AGENT_SCRIPT_PATH: z.string().optional(),
  MC_HOST: z.string().default('localhost'),
  MC_PORT: numberFromString('25565'),
  MC_VERSION: z.string().default('1.20.1'),
});

export type BsmConfig = z.infer<typeof bsmConfigSchema>;

// Bot Agent Configuration Schema
export const agentConfigSchema = z.object({
  AGENT_ID: z.string().optional(),
  BSM_TCP_PORT: numberFromString('4001'),
  BSM_HOST: z.string().default('127.0.0.1'),
  MC_HOST: z.string().default('localhost'),
  MC_PORT: numberFromString('25565'),
  MC_VERSION: z.string().default('1.20.1'),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// Squad Leader Configuration Schema
export const squadLeaderConfigSchema = z.object({
  SQUAD_ID: z.string().optional(),
  ORCHESTRATOR_ADDRESS: z.string().url(),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
});

export type SquadLeaderConfig = z.infer<typeof squadLeaderConfigSchema>;

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
