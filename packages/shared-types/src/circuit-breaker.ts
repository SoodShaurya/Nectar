import { CircuitBreakerError } from './errors';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeout?: number;
  resetTimeout?: number;
  onStateChange?: (state: CircuitBreakerState) => void;
}

/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascading failures by stopping requests to failing services
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailTime: number = 0;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly resetTimeout: number;
  private readonly onStateChange?: (state: CircuitBreakerState) => void;

  constructor(
    private readonly serviceName: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeout = options.timeout ?? 60000; // 1 minute
    this.resetTimeout = options.resetTimeout ?? 30000; // 30 seconds
    this.onStateChange = options.onStateChange;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === 'open') {
      const timeSinceLastFail = Date.now() - this.lastFailTime;

      if (timeSinceLastFail > this.resetTimeout) {
        this.changeState('half-open');
      } else {
        throw new CircuitBreakerError(this.serviceName);
      }
    }

    try {
      const result = await Promise.race([
        fn(),
        this.timeoutPromise(),
      ]);

      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;

    if (this.state === 'half-open') {
      this.successes++;

      if (this.successes >= this.successThreshold) {
        this.successes = 0;
        this.changeState('closed');
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailTime = Date.now();
    this.successes = 0;

    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.changeState('open');
    }
  }

  private changeState(newState: CircuitBreakerState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }

  private timeoutPromise(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Circuit breaker timeout for ${this.serviceName}`));
      }, this.timeout);
    });
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailTime: this.lastFailTime,
    };
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailTime = 0;
  }
}
