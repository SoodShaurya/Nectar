import { RateLimitError } from './errors';

export interface RateLimiterOptions {
  maxCalls: number;
  windowMs: number;
  throwOnLimit?: boolean;
}

/**
 * Rate Limiter using sliding window algorithm
 */
export class RateLimiter {
  private calls: number[] = [];
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private readonly throwOnLimit: boolean;

  constructor(options: RateLimiterOptions) {
    this.maxCalls = options.maxCalls;
    this.windowMs = options.windowMs;
    this.throwOnLimit = options.throwOnLimit ?? true;
  }

  /**
   * Wait if rate limit would be exceeded
   */
  async waitIfNeeded(): Promise<void> {
    this.cleanup();

    if (this.calls.length >= this.maxCalls) {
      if (this.throwOnLimit) {
        throw new RateLimitError(
          `Rate limit exceeded: ${this.maxCalls} calls per ${this.windowMs}ms`
        );
      }

      const oldestCall = this.calls[0];
      const waitTime = this.windowMs - (Date.now() - oldestCall);

      if (waitTime > 0) {
        await this.sleep(waitTime);
      }

      this.cleanup();
    }

    this.calls.push(Date.now());
  }

  /**
   * Check if rate limit would be exceeded without waiting
   */
  wouldExceed(): boolean {
    this.cleanup();
    return this.calls.length >= this.maxCalls;
  }

  /**
   * Get current usage statistics
   */
  getStats() {
    this.cleanup();
    return {
      currentCalls: this.calls.length,
      maxCalls: this.maxCalls,
      windowMs: this.windowMs,
      remainingCalls: Math.max(0, this.maxCalls - this.calls.length),
    };
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.calls = [];
  }

  /**
   * Remove calls outside the time window
   */
  private cleanup(): void {
    const now = Date.now();
    this.calls = this.calls.filter((time) => now - time < this.windowMs);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Token Bucket Rate Limiter
 * Allows bursts while maintaining average rate
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume tokens
   */
  async consume(tokens: number = 1): Promise<boolean> {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }

    return false;
  }

  /**
   * Wait until tokens are available
   */
  async waitForTokens(tokens: number = 1): Promise<void> {
    while (!(await this.consume(tokens))) {
      const timeToWait = (tokens - this.tokens) / this.refillRate * 1000;
      await this.sleep(Math.max(100, timeToWait));
    }
  }

  /**
   * Refill tokens based on time elapsed
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // convert to seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Get current token count
   */
  getTokens(): number {
    this.refill();
    return this.tokens;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
