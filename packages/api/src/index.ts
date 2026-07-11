export { openDb } from "./db/open.js";
export { resolveDbPath } from "./db/path.js";
export { runMigrations } from "./db/migrate.js";
export {
  Indexer,
  type IndexerOptions,
  type IndexerClient,
  type Logger,
  processBlock,
  detectCandidates,
  type Candidate,
  getSyncState,
  setSyncState,
  rollback,
  type SyncState,
} from "./indexer/index.js";

// Phase 4+ fills this in: Fastify server.
