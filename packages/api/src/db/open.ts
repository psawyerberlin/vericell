import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Network } from "core";
import { runMigrations } from "./migrate.js";
import { resolveDbPath } from "./path.js";

// dist/db/open.js -> ../../migrations = packages/api/migrations (mirrors
// src/db/open.ts -> ../../migrations, so this resolves the same way whether
// running compiled or via a TS loader).
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../migrations");

/** Open (creating + migrating if needed) the network-scoped SQLite DB. */
export function openDb(dbPath?: string, network?: Network): Database.Database {
  const resolved = dbPath ?? resolveDbPath(network);
  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}
