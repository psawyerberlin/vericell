import "fastify";
import type Database from "better-sqlite3";
import type { Network } from "core";
import type { FetchProofFn, GetTipFn } from "./chainLookup.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database.Database;
    network: Network;
    fetchProofFromChain: FetchProofFn;
    getChainTip: GetTipFn;
  }
}
