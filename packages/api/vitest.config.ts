import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Booting Fastify + swagger/swagger-ui the first time in a test file is
    // slow on WSL's /mnt/c filesystem; the default 5s timeout flakes there.
    testTimeout: 20000,
  },
});
