import { getStats } from "../queries.js";
import type { TypedApp } from "../build.js";

export function registerStatsRoutes(app: TypedApp): void {
  app.get(
    "/api/v1/stats",
    {
      schema: {
        tags: ["meta"],
        summary: "Totals: projects, versions, hashes indexed, sync height",
      },
    },
    async () => ({ network: app.network, ...getStats(app.db) }),
  );
}
