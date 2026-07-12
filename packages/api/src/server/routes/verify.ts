import { getHashMatches } from "../queries.js";
import { Sha256Params } from "../schemas.js";
import type { TypedApp } from "../build.js";

/** TECHNICAL.md §7.1 literal response shape: `{ found, live, project, version, block_time, path }`. */
export function registerVerifyRoutes(app: TypedApp): void {
  app.get(
    "/verify/:sha256",
    {
      schema: {
        tags: ["hashes"],
        summary: "Convenience verdict for a locally computed SHA-256 hash",
        params: Sha256Params,
      },
    },
    async (req) => {
      const matches = getHashMatches(app.db, req.params.sha256);
      if (matches.length === 0) {
        return {
          found: false,
          live: false,
          project: null,
          version: null,
          block_time: null,
          path: null,
        };
      }

      // Prefer a live (non-consumed) match; among ties, the most recently anchored.
      const best = [...matches].sort((a, b) => {
        const liveDiff = Number(b.status !== "consumed") - Number(a.status !== "consumed");
        if (liveDiff !== 0) return liveDiff;
        return (b.block_number ?? 0) - (a.block_number ?? 0);
      })[0]!;

      return {
        found: true,
        live: best.status !== "consumed",
        project: { unid: best.unid, title: best.title },
        version: { tx_hash: best.tx_hash, version_no: best.version_no, status: best.status },
        block_time: best.block_time,
        path: best.path,
      };
    },
  );
}
