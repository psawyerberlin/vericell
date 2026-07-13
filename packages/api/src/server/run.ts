import type Database from "better-sqlite3";
import pino from "pino";
import { NETWORK } from "core";
import { openDb } from "../db/open.js";
import { warnIfMainnet } from "../mainnetWarning.js";
import { buildServer, type NetworkBinding } from "./build.js";

/**
 * Standalone API server entrypoint (Phase 10's `api` compose service).
 *
 * Phase 10a: a single deployment serves both testnet and mainnet at once —
 * whenever `VERICELL_NETWORK` resolves to one of those two (the only real,
 * deployable networks), this process opens *both* their network-scoped DBs
 * and mounts both route trees, aliasing the bare `/api/v1/...` root at
 * whichever one `VERICELL_NETWORK` actually named. `devnet` is
 * offckb-local-testing-only (see TECHNICAL.md §11) and only ever runs one
 * instance at a time (`scripts/e2e.sh`, CI) — it keeps the pre-10a
 * single-network path, so a local/test run never needs a real connection to
 * public testnet/mainnet RPC endpoints just to serve devnet.
 */
async function main(): Promise<void> {
  const logger = pino({
    level: globalThis.process?.env?.LOG_LEVEL ?? "info",
    // Write routes (`/proofs*`, `/keys`) carry manifests, signed transactions
    // and bearer keys in their bodies/headers — never persist those to logs,
    // defense in depth on top of never `req.log`-ing a body in a handler.
    redact: {
      paths: ["req.body", "req.headers.authorization"],
      censor: "[redacted]",
    },
  });
  const port = Number(globalThis.process?.env?.PORT ?? 3000);
  const isDualNetwork = NETWORK === "testnet" || NETWORK === "mainnet";

  warnIfMainnet(logger, isDualNetwork ? "mainnet" : NETWORK);

  let app: ReturnType<typeof buildServer>;
  let dbs: Database.Database[];

  if (isDualNetwork) {
    // `DB_PATH` is a single explicit-file override (see `db/path.ts`) — it
    // makes no sense once this one process needs *two* separate DB files,
    // and honoring it naively here would silently point both networks at
    // the same file. Fail fast instead: dual-network mode always derives
    // both paths from `DB_DIR` (or its own `data/` default).
    if (globalThis.process?.env?.DB_PATH) {
      throw new Error(
        "DB_PATH is set but VERICELL_NETWORK is a dual-network value (testnet/mainnet) — " +
          "this process needs two separate DB files, one per network. Unset DB_PATH and use " +
          "DB_DIR instead (each network's file is named vericell.<network>.sqlite under it).",
      );
    }
    const testnetDb = openDb(undefined, "testnet");
    const mainnetDb = openDb(undefined, "mainnet");
    dbs = [testnetDb, mainnetDb];
    const networks: Partial<Record<"testnet" | "mainnet", NetworkBinding>> = {
      testnet: { db: testnetDb },
      mainnet: { db: mainnetDb },
    };
    app = buildServer({ networks, defaultNetwork: NETWORK, loggerInstance: logger });
  } else {
    const db = openDb();
    dbs = [db];
    app = buildServer({ db, network: NETWORK, loggerInstance: logger });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await app.close();
    for (const db of dbs) db.close();
    globalThis.process?.exit(0);
  };
  globalThis.process?.on("SIGINT", () => void shutdown("SIGINT"));
  globalThis.process?.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ network: NETWORK, dualNetwork: isDualNetwork, port }, "VeriCell API listening");
}

main().catch((err: unknown) => {
  console.error(err);
  globalThis.process?.exit(1);
});
