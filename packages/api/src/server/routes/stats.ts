import type Database from "better-sqlite3";
import type { Network } from "core";
import { getStats, type Stats } from "../queries.js";
import type { TypedApp } from "../build.js";

interface NetworkStats extends Stats {
  network: Network;
}

/**
 * Phase 10a: same alias/network-scope split as `health.ts` — the prefixed
 * mounts report only their own network; the alias additionally carries a
 * `networks` breakdown when `app.networkBindings` is set.
 */
export function registerStatsRoutes(app: TypedApp): void {
  app.get(
    "/stats",
    {
      schema: {
        tags: ["meta"],
        summary: "Totals: projects, versions, hashes indexed, sync height",
      },
    },
    async () => {
      const own: NetworkStats = { network: app.network, ...getStats(app.db) };
      if (!app.networkBindings) return own;

      const networks: Record<string, NetworkStats> = {};
      for (const [network, binding] of Object.entries(app.networkBindings) as [
        Network,
        { db: Database.Database },
      ][]) {
        networks[network] = network === app.network ? own : { network, ...getStats(binding.db) };
      }
      return { ...own, networks };
    },
  );
}
