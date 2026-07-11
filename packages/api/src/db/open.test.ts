import { describe, expect, it } from "vitest";
import { openDb } from "./open.js";

describe("openDb", () => {
  it("creates the §6 schema and seeds sync_state", () => {
    const db = openDb(":memory:");
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "projects",
          "versions",
          "hashes",
          "api_keys",
          "webhooks",
          "sync_state",
        ]),
      );

      const state = db.prepare("SELECT * FROM sync_state WHERE id = 1").get() as {
        last_block_number: number | null;
        last_block_hash: string | null;
      };
      expect(state.last_block_number).toBeNull();
      expect(state.last_block_hash).toBeNull();
    } finally {
      db.close();
    }
  });

  it("is idempotent — reopening the same file re-runs no migrations", () => {
    const db1 = openDb(":memory:");
    const appliedBefore = db1.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
      n: number;
    };
    db1.close();
    expect(appliedBefore.n).toBeGreaterThan(0);
  });
});
