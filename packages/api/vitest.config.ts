import { defineConfig } from "vitest/config";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";

export default defineConfig({
  test: {
    // Booting Fastify + swagger/swagger-ui the first time in a test file is
    // slow on WSL's /mnt/c filesystem; the default 5s timeout flakes there.
    // offckb suites anchor real devnet transactions and wait for them to
    // confirm, which is slower still — give them a lot more room.
    testTimeout: OFFCKB_ENABLED ? 300000 : 20000,
    hookTimeout: OFFCKB_ENABLED ? 60000 : 20000,
    // The indexer and proofs offckb suites both build transactions against
    // the same funded devnet account: with vitest's default file parallelism,
    // one suite can select a cell as input that the other has already spent
    // (but not yet confirmed), which the node then rejects with a 502
    // TransactionFailedToResolve. Running offckb suites one file at a time
    // avoids the race regardless of how many devnet accounts are configured.
    fileParallelism: !OFFCKB_ENABLED,
  },
});
