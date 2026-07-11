import type { ProofResult } from "chain";
import { BadGatewayError, NotFoundError } from "../errors.js";
import { getVersion } from "../queries.js";
import { TxHashParams } from "../schemas.js";
import type { TypedApp } from "../build.js";

/**
 * Indexed rows never persist the raw on-chain manifest (TECHNICAL.md §6's
 * `versions` table only keeps `project_sha256`/`merkle_root`), so a chain
 * lookup runs on every request to supply `manifest`/`live`/`owner_address`.
 * `source` still distinguishes the two cases: "index" when the tx is already
 * indexed (version_no/status/prev_tx_hash come from the DB — the chain call
 * only fills in manifest details), "chain" when it's a proof the indexer
 * hasn't seen yet and every field is derived from the direct RPC lookup.
 */
export function registerVersionRoutes(app: TypedApp): void {
  app.get(
    "/api/v1/versions/:txHash",
    {
      schema: {
        tags: ["versions"],
        summary: "One version: manifest, chain status, block info and owner",
        params: TxHashParams,
      },
    },
    async (req) => {
      const { txHash } = req.params;
      const dbRow = getVersion(app.db, txHash);

      let proof: ProofResult | null = null;
      try {
        proof = await app.fetchProofFromChain(txHash);
      } catch (err) {
        if (!dbRow) {
          throw new BadGatewayError(
            `Chain lookup for "${txHash}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        req.log.warn({ err, txHash }, "chain lookup failed; serving indexed data only");
      }

      if (!dbRow && (!proof || proof.manifest === null)) {
        throw new NotFoundError(`No version with tx hash "${txHash}"`);
      }

      const source: "index" | "chain" = dbRow ? "index" : "chain";
      const status =
        dbRow?.status ??
        (proof?.live === true ? "committed" : proof?.live === false ? "consumed" : "unknown");

      return {
        tx_hash: txHash,
        source,
        unid: dbRow?.unid ?? proof?.manifest?.genesis ?? txHash,
        status,
        version_no: dbRow?.version_no ?? null,
        prev_tx_hash: dbRow?.prev_tx_hash ?? proof?.manifest?.prev ?? null,
        project_sha256: dbRow?.project_sha256 ?? proof?.manifest?.project_sha256 ?? null,
        merkle_root: dbRow?.merkle_root ?? proof?.manifest?.merkle_root ?? null,
        manifest: proof?.manifest ?? null,
        live: proof?.live ?? null,
        block_number:
          dbRow?.block_number ?? (proof?.blockNumber != null ? Number(proof.blockNumber) : null),
        block_time: dbRow?.block_time ?? proof?.blockTime?.toISOString() ?? null,
        owner_address: proof?.ownerAddress ?? null,
      };
    },
  );
}
