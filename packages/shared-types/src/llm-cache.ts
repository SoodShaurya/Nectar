import { createHash } from 'crypto';

export interface CacheEntry<T> {
  response: T;
  timestamp: number;
  hits: number;
}

/**
 * LLM Response Cache
 * Caches LLM responses to reduce API calls and costs
 */
export class LLMCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttl: number;
  private readonly maxSize: number;

  constructor(options: { ttl?: number; maxSize?: number } = {}) {
    this.ttl = options.ttl ?? 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize ?? 1000; // Max 1000 entries
  }

  /**
   * Generate cache key from prompt and context
   */
  getCacheKey(prompt: string, context?: any): string {
    const data = context
      ? JSON.stringify({ prompt, context })
      : prompt;

    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Get cached response
   */
  get(key: string): T | null {
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check if expired
    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Increment hit counter
    cached.hits++;

    return cached.response;
  }

  /**
   * Set cached response
   */
  set(key: string, response: T): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  /**
   * Check if key exists and is valid
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Evict oldest entry
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    let totalHits = 0;
    const now = Date.now();
    let validEntries = 0;

    for (const entry of this.cache.values()) {
      if (now - entry.timestamp <= this.ttl) {
        totalHits += entry.hits;
        validEntries++;
      }
    }

    return {
      size: validEntries,
      maxSize: this.maxSize,
      totalHits,
      ttl: this.ttl,
    };
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }
}
