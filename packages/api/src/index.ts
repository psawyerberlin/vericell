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
export { buildServer, type BuildServerOptions, type TypedApp } from "./server/build.js";
export {
  defaultFetchProof,
  defaultGetTip,
  type FetchProofFn,
  type GetTipFn,
} from "./server/chainLookup.js";
export { ProblemError, NotFoundError, BadGatewayError } from "./server/errors.js";

// Phase 5+ fills this in: authenticated write endpoints.
