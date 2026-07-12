import { defineConfig } from "vitest/config";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";

export default defineConfig({
  test: {
    // The e2e suite spawns the compiled CLI as a subprocess, rebuilds it,
    // waits on real devnet confirmations and runs the indexer against them
    // — all slower than a normal unit test. Mirrors packages/api's config.
    testTimeout: OFFCKB_ENABLED ? 300000 : 20000,
    hookTimeout: OFFCKB_ENABLED ? 120000 : 20000,
    // This suite's `beforeAll` builds transactions against the same funded
    // devnet account as packages/chain's and packages/api's offckb suites
    // (see docs/DECISIONS.md, "Phase 5" entry, for the TransactionFailedToResolve
    // race this avoids) — run offckb suites one file at a time.
    fileParallelism: !OFFCKB_ENABLED,
  },
});
