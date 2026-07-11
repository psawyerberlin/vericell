import { getHashMatches } from "../queries.js";
import { Sha256Params } from "../schemas.js";
import type { TypedApp } from "../build.js";

export function registerHashRoutes(app: TypedApp): void {
  app.get(
    "/api/v1/hashes/:sha256",
    {
      schema: {
        tags: ["hashes"],
        summary: "Backward search: every project/version/path containing this file hash",
        params: Sha256Params,
      },
    },
    async (req) => {
      const matches = getHashMatches(app.db, req.params.sha256);
      return { sha256: req.params.sha256, matches };
    },
  );
}
