/**
 * Simple in-memory metrics collector
 */
export class MetricsCollector {
  private metrics: Map<string, number[]> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();

  /**
   * Record a metric value (for histograms/timings)
   */
  record(metric: string, value: number): void {
    if (!this.metrics.has(metric)) {
      this.metrics.set(metric, []);
    }
    this.metrics.get(metric)!.push(value);

    // Keep only last 1000 values to prevent memory issues
    const values = this.metrics.get(metric)!;
    if (values.length > 1000) {
      values.shift();
    }
  }

  /**
   * Increment a counter
   */
  increment(counter: string, value: number = 1): void {
    const current = this.counters.get(counter) || 0;
    this.counters.set(counter, current + value);
  }

  /**
   * Set a gauge value (current state)
   */
  setGauge(gauge: string, value: number): void {
    this.gauges.set(gauge, value);
  }

  /**
   * Get statistics for a metric
   */
  getStats(metric: string) {
    const values = this.metrics.get(metric) || [];

    if (values.length === 0) {
      return {
        count: 0,
        avg: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      count: values.length,
      avg: sum / values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: this.percentile(sorted, 0.5),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
    };
  }

  /**
   * Get counter value
   */
  getCounter(counter: string): number {
    return this.counters.get(counter) || 0;
  }

  /**
   * Get gauge value
   */
  getGauge(gauge: string): number | undefined {
    return this.gauges.get(gauge);
  }

  /**
   * Get all metrics summary
   */
  getAllMetrics() {
    const summary: any = {
      histograms: {},
      counters: {},
      gauges: {},
    };

    // Histograms/timings
    for (const [metric, values] of this.metrics.entries()) {
      summary.histograms[metric] = this.getStats(metric);
    }

    // Counters
    for (const [counter, value] of this.counters.entries()) {
      summary.counters[counter] = value;
    }

    // Gauges
    for (const [gauge, value] of this.gauges.entries()) {
      summary.gauges[gauge] = value;
    }

    return summary;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear();
    this.counters.clear();
    this.gauges.clear();
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Measure execution time of a function
   */
  async measureAsync<T>(
    metric: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.record(metric, Date.now() - start);
      this.increment(`${metric}_success`);
      return result;
    } catch (error) {
      this.record(metric, Date.now() - start);
      this.increment(`${metric}_error`);
      throw error;
    }
  }

  /**
   * Measure execution time of a synchronous function
   */
  measure<T>(metric: string, fn: () => T): T {
    const start = Date.now();
    try {
      const result = fn();
      this.record(metric, Date.now() - start);
      this.increment(`${metric}_success`);
      return result;
    } catch (error) {
      this.record(metric, Date.now() - start);
      this.increment(`${metric}_error`);
      throw error;
    }
  }
}

// Global metrics instance
export const metrics = new MetricsCollector();
