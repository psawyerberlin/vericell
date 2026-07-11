import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/open.js";
import { buildServer } from "../server/build.js";

// dist/scripts/writeOpenapi.js -> ../../../../docs = repo root docs/ (mirrors
// db/open.ts's ../../migrations resolution: two levels up reaches
// packages/api, two more reach the repo root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../../../../docs/openapi.json");

/** Build step (TECHNICAL.md §7, Phase 4 task 4): dump the OpenAPI 3.1 spec to `docs/openapi.json`. */
async function main(): Promise<void> {
  const db = openDb(":memory:");
  const app = buildServer({
    db,
    fetchProof: async () => ({
      manifest: null,
      live: null,
      blockNumber: null,
      blockTime: null,
      ownerAddress: null,
    }),
    getTip: async () => 0n,
  });

  await app.ready();
  const spec = app.swagger();

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(spec, null, 2) + "\n");

  await app.close();
  db.close();
}

main().catch((err: unknown) => {
  console.error(err);
  globalThis.process?.exit(1);
});
