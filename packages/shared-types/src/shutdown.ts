import { Logger } from './logger';

export type ShutdownHandler = () => Promise<void> | void;

/**
 * Graceful Shutdown Manager
 * Handles process signals and ensures clean shutdown
 */
export class GracefulShutdown {
  private handlers: ShutdownHandler[] = [];
  private isShuttingDown = false;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    this.setupSignalHandlers();
  }

  /**
   * Register a shutdown handler
   * Handlers are executed in reverse order of registration (LIFO)
   */
  register(handler: ShutdownHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Trigger graceful shutdown
   */
  async shutdown(signal?: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger?.warn('Shutdown already in progress...');
      return;
    }

    this.isShuttingDown = true;

    if (signal) {
      this.logger?.info(`Received ${signal}, shutting down gracefully...`);
    } else {
      this.logger?.info('Shutting down gracefully...');
    }

    // Execute handlers in reverse order
    const reversedHandlers = [...this.handlers].reverse();

    for (let i = 0; i < reversedHandlers.length; i++) {
      const handler = reversedHandlers[i];
      try {
        this.logger?.debug(`Executing shutdown handler ${i + 1}/${reversedHandlers.length}`);
        await Promise.race([
          handler(),
          this.timeout(30000), // 30 second timeout per handler
        ]);
      } catch (error) {
        this.logger?.error(`Error in shutdown handler ${i + 1}:`, error);
      }
    }

    this.logger?.info('Graceful shutdown complete');
    process.exit(0);
  }

  /**
   * Setup signal handlers for SIGTERM and SIGINT
   */
  private setupSignalHandlers(): void {
    process.on('SIGTERM', () => {
      void this.shutdown('SIGTERM');
    });

    process.on('SIGINT', () => {
      void this.shutdown('SIGINT');
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger?.error('Uncaught exception:', error);
      void this.shutdown('uncaughtException');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger?.error('Unhandled rejection at:', promise, 'reason:', reason);
      void this.shutdown('unhandledRejection');
    });
  }

  /**
   * Timeout promise helper
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Shutdown handler timeout after ${ms}ms`));
      }, ms);
    });
  }
}

/**
 * Create a global graceful shutdown instance
 */
export function createGracefulShutdown(logger?: Logger): GracefulShutdown {
  return new GracefulShutdown(logger);
}
