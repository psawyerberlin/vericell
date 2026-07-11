import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Plain-`.sql` migration runner: every `NNNN_*.sql` file in `migrationsDir`
 * is applied at most once, in filename order, tracked in a
 * `schema_migrations` bookkeeping table (not part of TECHNICAL.md §6 — an
 * implementation detail of "a migration runner", not a schema deviation).
 */
export function runMigrations(db: Database.Database, migrationsDir: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => (row as { id: string }).id),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    apply();
  }
}
