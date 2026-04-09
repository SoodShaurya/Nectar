import { EventEmitter } from 'events';
import { Bot } from 'mineflayer';
import { ModuleState, ModuleContext, ReportEventFn, AgentModule } from '../types';

export abstract class BaseModule extends EventEmitter implements AgentModule {
  abstract readonly name: string;
  protected state: ModuleState = 'idle';
  protected bot: Bot;
  protected reportEvent: ReportEventFn;
  protected ctx: ModuleContext;
  private abortController: AbortController | null = null;

  constructor(ctx: ModuleContext) {
    super();
    this.bot = ctx.bot;
    this.reportEvent = ctx.reportEvent;
    this.ctx = ctx;
  }

  activate(params: any): void {
    if (this.state === 'active') {
      this.deactivate();
    }
    this.state = 'active';
    this.abortController = new AbortController();
    this.run(params, this.abortController.signal).catch((err) => {
      if (this.state === 'active') {
        this.fail(err instanceof Error ? err.message : String(err));
      }
    });
  }

  deactivate(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.state = 'idle';
    this.cleanup();
  }

  pause(): void {
    if (this.state === 'active') {
      this.state = 'paused';
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      this.state = 'active';
    }
  }

  getState(): ModuleState {
    return this.state;
  }

  protected complete(data?: any): void {
    this.state = 'completed';
    this.abortController = null;
    this.emit('complete', data ?? {});
  }

  protected fail(reason: string, data?: any): void {
    this.state = 'failed';
    this.abortController = null;
    this.emit('failed', { reason, ...data });
  }

  protected alert(data: any): void {
    this.emit('alert', data);
  }

  protected isAborted(signal: AbortSignal): boolean {
    return signal.aborted || this.state !== 'active';
  }

  protected waitWhilePaused(): Promise<void> {
    if (this.state !== 'paused') return Promise.resolve();
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.state !== 'paused') {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  protected abstract run(params: any, signal: AbortSignal): Promise<void>;
  protected cleanup(): void {}
}
