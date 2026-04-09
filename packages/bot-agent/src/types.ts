import { EventEmitter } from 'events';
import { Bot } from 'mineflayer';
import { Coordinates } from '@aetherius/shared-types';

// --- Module State ---
export type ModuleState = 'idle' | 'active' | 'completed' | 'failed' | 'paused';

// --- Agent Module Interface ---
export interface AgentModule {
  name: string;
  activate(params: any): void;
  deactivate(): void;
  pause(): void;
  resume(): void;
  getState(): ModuleState;
  on(event: 'complete' | 'failed' | 'alert', callback: (data: any) => void): this;
}

// --- Report Function ---
export type ReportEventFn = (event: {
  eventType: string;
  taskId?: string;
  details?: any;
}) => void;

// --- Module Context (passed to all modules on construction) ---
export interface ModuleContext {
  bot: Bot;
  reportEvent: ReportEventFn;
  getNavigationModule?: () => AgentModule;
}
