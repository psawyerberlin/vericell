import { getSyncState } from "../../indexer/reorg.js";
import type { TypedApp } from "../build.js";

export function registerHealthRoutes(app: TypedApp): void {
  app.get(
    "/api/v1/health",
    { schema: { tags: ["meta"], summary: "Liveness and indexer lag (tip - cursor)" } },
    async (req) => {
      const { lastBlockNumber: cursor } = getSyncState(app.db);

      let tip: bigint | null = null;
      let chainReachable = true;
      try {
        tip = await app.getChainTip();
      } catch (err) {
        chainReachable = false;
        req.log.warn({ err }, "health check: chain tip lookup failed");
      }

      const lag = tip !== null && cursor !== null ? Number(tip - cursor) : null;

      return {
        status: "ok",
        network: app.network,
        indexer: {
          cursor: cursor === null ? null : Number(cursor),
          tip: tip === null ? null : Number(tip),
          lag,
          chain_reachable: chainReachable,
        },
      };
    },
  );
}
