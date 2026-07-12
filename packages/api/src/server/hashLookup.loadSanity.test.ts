/**
 * Phase 9 acceptance: seed 10k projects / 200k hashes directly into the DB
 * (bypassing the indexer — this is a query-performance check, not an
 * indexing-correctness one, which Phase 3's suites already cover) and assert
 * `GET /api/v1/hashes/{sha256}` responds in under 50ms. `getHashMatches`
 * (`server/queries.ts`) UNIONs a lookup by `hashes.sha256` (indexed since
 * `0001_init.sql`) with one by `versions.project_sha256`, which had no index
 * until `migrations/0004_perf_indexes.sql` — see that file and
 * `docs/SECURITY.md` §load-sanity for what this test caught.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db/open.js";
import { buildServer, type TypedApp } from "./build.js";

const PROJECT_COUNT = 10_000;
const HASH_COUNT = 200_000;
const HASHES_PER_PROJECT = HASH_COUNT / PROJECT_COUNT;
const MAX_RESPONSE_MS = 50;

/** 64-char hex, unique per n — fast to generate, no need for real SHA-256 in a load fixture. */
function fakeHex64(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function fakeTxHash(n: number): string {
  return "0x" + fakeHex64(n);
}

function seedLoad(db: Database.Database): { midSha256: string } {
  const now = new Date().toISOString();

  const insertProject = db.prepare(
    `INSERT INTO projects (unid, title, source_url, ckb_address, created_at, active, live_tx_hash, live_index)
     VALUES (@unid, @title, NULL, @ckbAddress, @createdAt, 1, @txHash, 0)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO versions (tx_hash, unid, version_no, prev_tx_hash, project_sha256, merkle_root, block_number, block_time, status)
     VALUES (@txHash, @unid, 1, NULL, @projectSha256, @merkleRoot, @blockNumber, @blockTime, 'committed')`,
  );
  const insertHash = db.prepare(
    "INSERT INTO hashes (sha256, tx_hash, path) VALUES (@sha256, @txHash, @path)",
  );

  let midSha256 = "";

  const seedAll = db.transaction(() => {
    for (let p = 0; p < PROJECT_COUNT; p++) {
      const unid = fakeTxHash(p);
      const txHash = unid;
      insertProject.run({
        unid,
        title: `Load Project ${p}`,
        ckbAddress: `ckt1qload${p % 500}`,
        createdAt: now,
        txHash,
      });
      insertVersion.run({
        txHash,
        unid,
        projectSha256: fakeHex64(1_000_000 + p),
        merkleRoot: fakeHex64(2_000_000 + p),
        blockNumber: p,
        blockTime: now,
      });
      for (let h = 0; h < HASHES_PER_PROJECT; h++) {
        const n = p * HASHES_PER_PROJECT + h;
        const sha256 = fakeHex64(n);
        if (n === Math.floor(HASH_COUNT / 2)) midSha256 = sha256;
        insertHash.run({ sha256, txHash, path: `file-${h}.txt` });
      }
    }
  });
  seedAll();

  return { midSha256 };
}

describe("load sanity: 10k projects / 200k hashes", () => {
  let app: TypedApp;
  let midSha256: string;

  beforeAll(async () => {
    const db = openDb(":memory:");
    const seeded = seedLoad(db);
    midSha256 = seeded.midSha256;
    app = buildServer({
      db,
      network: "devnet",
      rateLimit: { max: 100_000, timeWindow: "1 minute" },
    });

    // Fastify compiles each route's validator/serializer lazily on its
    // first request — a one-time cost of tens to hundreds of ms unrelated
    // to the DB query this suite is actually checking (confirmed via
    // EXPLAIN QUERY PLAN + direct better-sqlite3 timing: the indexed query
    // itself runs in well under 1ms against this fixture). Warm both routes
    // once before asserting steady-state latency below, same as any real
    // load-test methodology excludes cold start from its measurements.
    await app.inject({ method: "GET", url: `/api/v1/hashes/${seeded.midSha256}` });
    await app.inject({ method: "GET", url: `/api/v1/verify/${seeded.midSha256}` });
  }, 60_000);

  it(`GET /hashes/{sha256} responds in under ${MAX_RESPONSE_MS}ms against 200k hashes`, async () => {
    const start = performance.now();
    const res = await app.inject({ method: "GET", url: `/api/v1/hashes/${midSha256}` });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(MAX_RESPONSE_MS);
  });

  it(`GET /verify/{sha256} (same query path) also responds in under ${MAX_RESPONSE_MS}ms`, async () => {
    const start = performance.now();
    const res = await app.inject({ method: "GET", url: `/api/v1/verify/${midSha256}` });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
    expect(elapsedMs).toBeLessThan(MAX_RESPONSE_MS);
  });

  it("GET /hashes/{sha256} for a hash that doesn't exist returns no matches quickly", async () => {
    const start = performance.now();
    const res = await app.inject({ method: "GET", url: `/api/v1/hashes/${"f".repeat(64)}` });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(MAX_RESPONSE_MS);
  });
});
