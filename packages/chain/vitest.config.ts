import { defineConfig } from "vitest/config";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";

export default defineConfig({
  test: {
    // offckb suites anchor real devnet transactions and wait for them to
    // confirm, which can be slow on a loaded or freshly-started devnet node.
    testTimeout: OFFCKB_ENABLED ? 300000 : 5000,
    hookTimeout: OFFCKB_ENABLED ? 60000 : 10000,
  },
});
