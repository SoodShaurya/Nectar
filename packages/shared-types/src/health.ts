export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  status: 'connected' | 'disconnected' | 'degraded';
  latency?: number;
  lastCheck?: string;
  error?: string;
}

export interface HealthCheckResponse {
  service: string;
  status: HealthStatus;
  uptime: number;
  timestamp: string;
  version?: string;
  dependencies: {
    [key: string]: DependencyHealth;
  };
  metrics?: {
    [key: string]: any;
  };
}

export type HealthCheckFunction = () => Promise<DependencyHealth>;

/**
 * Health Check Manager
 */
export class HealthCheck {
  private dependencies = new Map<string, HealthCheckFunction>();
  private startTime: number;

  constructor(
    private serviceName: string,
    private version?: string
  ) {
    this.startTime = Date.now();
  }

  /**
   * Register a dependency health check
   */
  registerDependency(name: string, checkFn: HealthCheckFunction): void {
    this.dependencies.set(name, checkFn);
  }

  /**
   * Perform health check
   */
  async check(): Promise<HealthCheckResponse> {
    const dependencies: { [key: string]: DependencyHealth } = {};
    const checks: Promise<void>[] = [];

    // Check all dependencies in parallel
    for (const [name, checkFn] of this.dependencies.entries()) {
      checks.push(
        (async () => {
          try {
            const result = await Promise.race([
              checkFn(),
              this.timeout(5000, name),
            ]);
            dependencies[name] = result;
          } catch (error) {
            dependencies[name] = {
              status: 'disconnected',
              error: error instanceof Error ? error.message : String(error),
              lastCheck: new Date().toISOString(),
            };
          }
        })()
      );
    }

    await Promise.all(checks);

    // Determine overall status
    const status = this.determineOverallStatus(dependencies);

    return {
      service: this.serviceName,
      status,
      uptime: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
      version: this.version,
      dependencies,
    };
  }

  /**
   * Determine overall health status based on dependencies
   */
  private determineOverallStatus(
    dependencies: { [key: string]: DependencyHealth }
  ): HealthStatus {
    const statuses = Object.values(dependencies).map((d) => d.status);

    if (statuses.some((s) => s === 'disconnected')) {
      return 'unhealthy';
    }

    if (statuses.some((s) => s === 'degraded')) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Timeout helper
   */
  private async timeout(ms: number, name: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Health check timeout for ${name} after ${ms}ms`));
      }, ms);
    });
  }
}

/**
 * Common health check helpers
 */
export const HealthChecks = {
  /**
   * Check MongoDB connection
   */
  mongodb: async (mongoose: any): Promise<DependencyHealth> => {
    const start = Date.now();
    try {
      if (mongoose.connection.readyState !== 1) {
        return {
          status: 'disconnected',
          error: 'MongoDB not connected',
          lastCheck: new Date().toISOString(),
        };
      }

      await mongoose.connection.db.admin().ping();

      return {
        status: 'connected',
        latency: Date.now() - start,
        lastCheck: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'disconnected',
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date().toISOString(),
      };
    }
  },

  /**
   * Check WebSocket connection
   */
  websocket: (ws: any): Promise<DependencyHealth> => {
    return Promise.resolve({
      status: ws && ws.readyState === 1 ? 'connected' : 'disconnected',
      lastCheck: new Date().toISOString(),
    });
  },

  /**
   * Check HTTP endpoint
   */
  http: async (url: string): Promise<DependencyHealth> => {
    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          status: 'degraded',
          latency: Date.now() - start,
          error: `HTTP ${response.status}`,
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        status: 'connected',
        latency: Date.now() - start,
        lastCheck: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'disconnected',
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date().toISOString(),
      };
    }
  },

  /**
   * Check TCP connection
   */
  tcp: (host: string, port: number): Promise<DependencyHealth> => {
    const start = Date.now();
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();

      socket.setTimeout(5000);

      socket.on('connect', () => {
        socket.destroy();
        resolve({
          status: 'connected',
          latency: Date.now() - start,
          lastCheck: new Date().toISOString(),
        });
      });

      socket.on('error', (error: Error) => {
        resolve({
          status: 'disconnected',
          error: error.message,
          lastCheck: new Date().toISOString(),
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          status: 'disconnected',
          error: 'Connection timeout',
          lastCheck: new Date().toISOString(),
        });
      });

      socket.connect(port, host);
    });
  },
};
