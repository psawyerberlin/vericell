import "fastify";
import type Database from "better-sqlite3";
import type { Network } from "core";
import type { FetchProofFn, GetTipFn } from "./chainLookup.js";
import type { GetChainClientFn } from "./chainClient.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database.Database;
    network: Network;
    fetchProofFromChain: FetchProofFn;
    getChainTip: GetTipFn;
    getChainClient: GetChainClientFn;
    /** `undefined` when ADMIN_TOKEN isn't configured — `POST /keys` 500s rather than accepting any caller. */
    adminToken: string | undefined;
    /**
     * Only decorated on the network-less alias scope (`/api/v1/...`,
     * Phase 10a) — every configured network's db + tip lookup, so `/health`
     * and `/stats` can report every mounted network there, not just the
     * default one. Absent on the `/api/v1/<network>/...` scopes, which only
     * ever report their own single network.
     */
    networkBindings?: Partial<Record<Network, { db: Database.Database; getTip: GetTipFn }>>;
  }

  interface FastifyRequest {
    /** Set by `requireApiKey` once the bearer token has been resolved to an `api_keys` row. */
    apiKeyHash?: string;
  }
}
