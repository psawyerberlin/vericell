import type Database from "better-sqlite3";
import type { Network } from "core";
import { getSyncState } from "../../indexer/reorg.js";
import type { GetTipFn } from "../chainLookup.js";
import type { TypedApp } from "../build.js";

interface HealthInfo {
  network: Network;
  status: "ok";
  indexer: {
    cursor: number | null;
    tip: number | null;
    lag: number | null;
    chain_reachable: boolean;
  };
}

async function computeHealth(
  db: Database.Database,
  network: Network,
  getTip: GetTipFn,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<HealthInfo> {
  const { lastBlockNumber: cursor } = getSyncState(db);

  let tip: bigint | null = null;
  let chainReachable = true;
  try {
    tip = await getTip();
  } catch (err) {
    chainReachable = false;
    log.warn({ err, network }, "health check: chain tip lookup failed");
  }

  const lag = tip !== null && cursor !== null ? Number(tip - cursor) : null;

  return {
    network,
    status: "ok",
    indexer: {
      cursor: cursor === null ? null : Number(cursor),
      tip: tip === null ? null : Number(tip),
      lag,
      chain_reachable: chainReachable,
    },
  };
}

/**
 * Phase 10a: the network-scoped mounts (`/api/v1/testnet/health`,
 * `/api/v1/mainnet/health`) report only their own network, unchanged from
 * pre-10a behavior. The alias (`/api/v1/health`, no network segment) is the
 * one place `app.networkBindings` is set (see `build.ts`) — when present,
 * the response additionally carries a `networks` breakdown for every
 * mounted network, per ClaudeCodeInstruction.md's "aliased root shows both."
 */
export function registerHealthRoutes(app: TypedApp): void {
  app.get(
    "/health",
    { schema: { tags: ["meta"], summary: "Liveness and indexer lag (tip - cursor)" } },
    async (req) => {
      const own = await computeHealth(app.db, app.network, app.getChainTip, req.log);
      if (!app.networkBindings) return own;

      const networks: Record<string, HealthInfo> = {};
      for (const [network, binding] of Object.entries(app.networkBindings) as [
        Network,
        { db: Database.Database; getTip: GetTipFn },
      ][]) {
        networks[network] =
          network === app.network
            ? own
            : await computeHealth(binding.db, network, binding.getTip, req.log);
      }
      return { ...own, networks };
    },
  );
}
