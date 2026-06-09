/**
 * World State Service query wrapper.
 * Provides typed access to POIs, resources, infrastructure, and storage contents.
 */

import { Coordinates, createLogger, metrics } from '@aetherius/shared-types';

const logger = createLogger('coordinator:world-state');

export class WorldStateClient {
  private apiAddress: string;

  constructor(apiAddress: string) {
    this.apiAddress = apiAddress;
  }

  /**
   * General query to world state service.
   */
  async query(params: Record<string, any>): Promise<any> {
    const startTime = Date.now();
    try {
      const urlParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        urlParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }

      const response = await fetch(`${this.apiAddress}/query?${urlParams.toString()}`);
      if (!response.ok) {
        logger.error('World state query failed', { status: response.status });
        metrics.increment('world_state_query_errors');
        return null;
      }

      const results = await response.json();
      metrics.record('world_state_query_duration', Date.now() - startTime);
      metrics.increment('world_state_queries_successful');
      return results;
    } catch (error) {
      logger.error('World state fetch error', { error });
      metrics.increment('world_state_query_errors');
      return null;
    }
  }

  /**
   * Get known storage contents (chests with logged items).
   * Returns a map of locationKey → { itemName: count }
   */
  async getStorageContents(): Promise<Record<string, Record<string, number>>> {
    const storage: Record<string, Record<string, number>> = {};

    try {
      const pois = await this.query({ type: 'poi', filter: JSON.stringify({ type: 'chest' }), options: JSON.stringify({ limit: 100 }) });
      if (!pois || !Array.isArray(pois)) return storage;

      for (const poi of pois) {
        if (poi.details?.contents && Array.isArray(poi.details.contents)) {
          const coords = poi.coords || poi.data?.coords;
          if (!coords) continue;

          const key = `${Math.floor(coords.x)},${Math.floor(coords.y)},${Math.floor(coords.z)}`;
          const items: Record<string, number> = {};
          for (const item of poi.details.contents) {
            if (item.name && item.count) {
              items[item.name] = (items[item.name] ?? 0) + item.count;
            }
          }
          storage[key] = items;
        }
      }
    } catch (error) {
      logger.error('Failed to fetch storage contents', { error });
    }

    return storage;
  }

  /**
   * Get a summary of world state for LLM context.
   */
  async getWorldSummary(): Promise<string> {
    try {
      const [pois, resources, infra] = await Promise.all([
        this.query({ type: 'poi', options: JSON.stringify({ limit: 20 }) }),
        this.query({ type: 'resourceNode', options: JSON.stringify({ limit: 20 }) }),
        this.query({ type: 'infrastructure', options: JSON.stringify({ limit: 10 }) }),
      ]);

      const summary: any = {
        knownPOIs: pois?.length ?? 0,
        knownResources: resources?.length ?? 0,
        knownInfrastructure: infra?.length ?? 0,
        pois: (pois ?? []).map((p: any) => ({ type: p.type ?? p.data?.type, coords: p.coords ?? p.data?.coords })),
        resources: (resources ?? []).map((r: any) => ({ type: r.resourceType ?? r.data?.resourceType, coords: r.coords ?? r.data?.coords })),
        infrastructure: (infra ?? []).map((i: any) => ({ type: i.type ?? i.data?.type, name: i.name ?? i.data?.name })),
      };

      return JSON.stringify(summary, null, 2);
    } catch (error) {
      logger.error('Failed to build world summary', { error });
      return '{"error": "Could not fetch world state summary"}';
    }
  }

  /**
   * Health check for the world state service.
   */
  async healthCheck(): Promise<{ status: 'connected' | 'disconnected' | 'degraded'; error?: string }> {
    try {
      const response = await fetch(`${this.apiAddress}/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return { status: 'connected' as const };
      }
      return { status: 'disconnected' as const, error: 'World State unhealthy' };
    } catch (error) {
      return { status: 'disconnected' as const, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
