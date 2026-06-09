/**
 * Aetherius inter-service message protocol — single source of truth.
 *
 * Every service that exchanges messages (coordinator ↔ BSM over WebSocket,
 * BSM ↔ agent over newline-delimited TCP) shares the constants and Zod
 * validators defined here. This eliminates the historical "stringly-typed"
 * protocol drift (e.g. `orchestrator::agentCommand`) and gives every network
 * boundary a single place to validate untrusted input.
 */

import { z } from 'zod';

/**
 * Wire protocol version. Bump on any breaking envelope/payload change.
 * Receivers should warn (not crash) on a mismatch so a partial rollout
 * degrades gracefully rather than going dark.
 */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Message type constants (WebSocket: coordinator ↔ BSM / frontend)
// ---------------------------------------------------------------------------

/**
 * Coordinator → BSM commands and BSM/frontend → coordinator messages.
 * These string literals ARE the wire format — change them only in lockstep
 * across coordinator, BSM, and bot-agent.
 */
export const MsgType = {
  // Coordinator → BSM (downstream commands). Renamed from the legacy
  // `orchestrator::*` prefix when the orchestrator + squad-leader tiers were
  // collapsed into the single coordinator.
  AgentCommand: 'coordinator::agentCommand',
  CancelTask: 'coordinator::cancelTask',
  ChatMessage: 'coordinator::chatMessage',
  UpdateProfile: 'coordinator::updateProfile',
  SpawnAgent: 'coordinator::spawnAgent',
  TerminateAgent: 'coordinator::terminateAgent',

  // BSM → Coordinator (upstream lifecycle)
  BsmRegister: 'bsm::register',
  BsmRegisterAck: 'bsm::registerAck',

  // Agent (relayed by BSM) → Coordinator
  AgentStatusUpdate: 'agent::statusUpdate',
  AgentEventPrefix: 'agent::event::',
  /** Acknowledgment that an agent received (and accepted/rejected) a command. */
  AgentCommandAck: 'agent::commandAck',

  // Frontend → Coordinator
  FrontendRegister: 'frontend::register',
  FrontendStartGoal: 'frontend::startGoal',

  // Frontend (browser via relay) → Coordinator
  FrontendChat: 'frontend::chat', // payload: { message: string, sender?: string }
  FrontendUpdateWhitelist: 'frontend::updateWhitelist', // payload: { enabled: boolean, players: string[] }
  FrontendGetState: 'frontend::getState', // payload: {}

  // Coordinator → Frontend (broadcast to registered frontend clients)
  CoordinatorChat: 'coordinator::chat', // payload: { from: string, kind: 'coordinator'|'player'|'system', message: string, ts: string }
  CoordinatorState: 'coordinator::state', // payload: CoordinatorStatePayload
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

/** Build the full WS type string for an agent event of a given event type. */
export const agentEventType = (eventType: string): string =>
  `${MsgType.AgentEventPrefix}${eventType}`;

// ---------------------------------------------------------------------------
// Message type constants (TCP: BSM ↔ agent, newline-delimited JSON)
// ---------------------------------------------------------------------------

/** BSM → agent (downstream) and agent → BSM (upstream) TCP frame types. */
export const TcpMsgType = {
  // BSM → agent
  Command: 'command',
  UpdateProfile: 'updateProfile',
  CancelTask: 'cancelTask',
  ChatMessage: 'chatMessage',
  RegisterAck: 'registerAck',

  // agent → BSM
  Register: 'register',
  Event: 'event',
  StatusUpdate: 'statusUpdate',
  /** Immediate ack from the agent that a command was received. */
  CommandAck: 'commandAck',
} as const;

export type TcpMsgTypeValue = (typeof TcpMsgType)[keyof typeof TcpMsgType];

// ---------------------------------------------------------------------------
// Envelope schemas
// ---------------------------------------------------------------------------

/** WebSocket message envelope (coordinator ↔ BSM ↔ frontend). */
export const webSocketMessageSchema = z.object({
  v: z.number().int().optional(),
  type: z.string().min(1),
  payload: z.unknown().optional(),
  senderId: z.string().optional(),
  timestamp: z.string().optional(),
});

/** TCP message envelope (BSM ↔ agent). */
export const tcpMessageSchema = z.object({
  v: z.number().int().optional(),
  type: z.string().min(1),
  payload: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Payload schemas for the high-value command/lifecycle messages.
//
// Nested, deeply-structured fields (task details, inventories, completion
// conditions) are intentionally left loose (`z.unknown()` / `z.any()`): the
// envelope + key scalar fields are what we gate on. Callers should validate,
// then use the ORIGINAL payload object so no fields are stripped.
// ---------------------------------------------------------------------------

export const agentCommandPayloadSchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().min(1),
  task: z.object({ type: z.string().min(1) }).loose(),
  completionCondition: z.unknown().optional(),
});

export const cancelTaskPayloadSchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().optional(),
});

export const chatMessagePayloadSchema = z.object({
  agentId: z.string().optional(),
  message: z.string(),
});

export const updateProfilePayloadSchema = z.object({
  agentId: z.string().min(1),
  profile: z.unknown().optional(),
}).loose();

export const bsmRegisterPayloadSchema = z.object({
  bsmId: z.string().min(1),
  address: z.string().min(1),
  capacity: z.number().optional(),
  agents: z.array(z.unknown()),
  authToken: z.string().optional(),
});

export const commandAckPayloadSchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().min(1),
  accepted: z.boolean(),
  reason: z.string().optional(),
});

/** Agent → BSM TCP registration frame. */
export const agentRegisterPayloadSchema = z.object({
  agentId: z.string().min(1),
  authToken: z.string().optional(),
}).loose();

// ---------------------------------------------------------------------------
// Frontend (web via relay) ↔ Coordinator payload schemas + types
// ---------------------------------------------------------------------------

/** frontend::chat — a chat message typed by the web user. */
export const frontendChatPayloadSchema = z.object({
  message: z.string(),
  sender: z.string().optional(),
});

/** frontend::updateWhitelist — runtime edit of the in-game chat whitelist. */
export const frontendUpdateWhitelistPayloadSchema = z.object({
  enabled: z.boolean(),
  players: z.array(z.string()),
});

/** coordinator::chat — a chat line broadcast to registered frontend clients. */
export const coordinatorChatPayloadSchema = z.object({
  from: z.string(),
  kind: z.enum(['coordinator', 'player', 'system']),
  message: z.string(),
  /** ISO-8601 timestamp of the moment the line was produced. */
  ts: z.string(),
});

export type CoordinatorChatPayload = z.infer<typeof coordinatorChatPayloadSchema>;

/** coordinator::state — full snapshot pushed to frontend clients. */
export interface CoordinatorStatePayload {
  goals: Array<{ goalId: string; description: string; priority: string; status: string }>;
  agents: Array<{
    agentId: string;
    status: string;
    currentTask: string | null;
    position: { x: number; y: number; z: number } | null;
    inventory: Record<string, number>;
  }>;
  whitelist: { enabled: boolean; players: string[] };
}

// ---------------------------------------------------------------------------
// Parse / construct helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** JSON.parse that never throws. */
export function safeJsonParse(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
}

export interface ValidatedWsMessage {
  v?: number;
  type: string;
  payload?: unknown;
  senderId?: string;
  timestamp?: string;
}

/**
 * Parse + envelope-validate a raw WebSocket frame. Returns a typed message or
 * a descriptive error. Use at every WS boundary instead of bare JSON.parse.
 */
export function parseWsMessage(raw: string | Buffer): ParseResult<ValidatedWsMessage> {
  const json = safeJsonParse(raw.toString());
  if (!json.ok) return json;
  const result = webSocketMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: `Invalid message envelope: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }
  return { ok: true, value: result.data as ValidatedWsMessage };
}

export interface ValidatedTcpMessage {
  v?: number;
  type: string;
  payload?: unknown;
}

/** Parse + envelope-validate a single newline-delimited TCP frame. */
export function parseTcpMessage(raw: string): ParseResult<ValidatedTcpMessage> {
  const json = safeJsonParse(raw);
  if (!json.ok) return json;
  const result = tcpMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: `Invalid TCP envelope: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }
  return { ok: true, value: result.data as ValidatedTcpMessage };
}

/** Construct a versioned, timestamped WebSocket message. */
export function makeWsMessage(type: string, payload: unknown, senderId?: string): ValidatedWsMessage {
  return { v: PROTOCOL_VERSION, type, payload, senderId, timestamp: new Date().toISOString() };
}

/** Validate a payload against a schema, returning the ORIGINAL payload on success (no stripping). */
export function validatePayload<T>(schema: z.ZodType<T>, payload: unknown): ParseResult<unknown> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: payload };
}

// ---------------------------------------------------------------------------
// Auth (shared-secret handshake)
// ---------------------------------------------------------------------------

/**
 * Constant-time-ish auth check for the optional cluster shared secret.
 *
 * If `expected` is empty/undefined, auth is DISABLED (local-dev default) and
 * every token is accepted — the caller is expected to log a one-time warning.
 * When configured, a presented token must match exactly.
 */
export function checkAuthToken(expected: string | undefined, presented: string | undefined): boolean {
  if (!expected) return true; // auth disabled
  if (!presented) return false;
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}
