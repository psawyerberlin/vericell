import type Database from "better-sqlite3";
import type { ProofResult } from "chain";
import type { Manifest } from "core";
import type { FetchProofFn, GetTipFn } from "./chainLookup.js";

/** 0x-prefixed 32-byte hex, shaped like a real CKB tx hash, for fixture readability. */
function txHash(tag: string): string {
  return "0x" + tag.repeat(64).slice(0, 64);
}

/** 64-char hex, shaped like a real SHA-256, for fixture readability. */
function sha(tag: string): string {
  return tag.repeat(64).slice(0, 64);
}

export const FIXTURE = {
  alpha: {
    unid: txHash("a1"),
    v1TxHash: txHash("a1"),
    v2TxHash: txHash("a2"),
    address: "ckt1qzda0y0dcnfe2gwzy2v8gy8dsxc6cd8v5uzkxs7lcggwx0v8fyq7alpha",
    fileHash: sha("f1"),
    fileHash2: sha("f2"),
  },
  beta: {
    unid: txHash("b1"),
    txHash: txHash("b1"),
    address: "ckt1qzda0y0dcnfe2gwzy2v8gy8dsxc6cd8v5uzkxs7lcggwx0v8fyq7beta0",
    fileHash: sha("f3"),
  },
  gamma: {
    unid: txHash("c1"),
    txHash: txHash("c1"),
    address: "ckt1qzda0y0dcnfe2gwzy2v8gy8dsxc6cd8v5uzkxs7lcggwx0v8fyq7gamma",
    fileHash: sha("f4"),
  },
  unindexedTxHash: txHash("d1"),
  syncState: { lastBlockNumber: 100, lastBlockHash: txHash("ee") },
};

/**
 * Seed a fixture DB directly with SQL (bypassing the indexer) so route tests
 * stay fast and independent of chain/offckb — Phase 3's indexer tests already
 * cover indexing correctness end to end.
 *
 *   alpha  — 2 versions: v1 consumed, v2 live (current project.live_tx_hash)
 *   beta   — 1 version, live, has a source_url
 *   gamma  — 1 version, consumed, project withdrawn (active = false)
 */
export function seedFixtureDb(db: Database.Database): typeof FIXTURE {
  const insertProject = db.prepare(
    `INSERT INTO projects (unid, title, source_url, ckb_address, created_at, active, live_tx_hash, live_index)
     VALUES (@unid, @title, @sourceUrl, @ckbAddress, @createdAt, @active, @liveTxHash, 0)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO versions (tx_hash, unid, version_no, prev_tx_hash, project_sha256, merkle_root, block_number, block_time, status)
     VALUES (@txHash, @unid, @versionNo, @prevTxHash, @projectSha256, @merkleRoot, @blockNumber, @blockTime, @status)`,
  );
  const insertHash = db.prepare(
    "INSERT INTO hashes (sha256, tx_hash, path) VALUES (@sha256, @txHash, @path)",
  );

  const a = FIXTURE.alpha;
  insertProject.run({
    unid: a.unid,
    title: "Alpha Project",
    sourceUrl: null,
    ckbAddress: a.address,
    createdAt: "2026-01-01T00:00:00.000Z",
    active: 1,
    liveTxHash: a.v2TxHash,
  });
  insertVersion.run({
    txHash: a.v1TxHash,
    unid: a.unid,
    versionNo: 1,
    prevTxHash: null,
    projectSha256: sha("p1"),
    merkleRoot: sha("m1"),
    blockNumber: 10,
    blockTime: "2026-01-01T00:00:00.000Z",
    status: "consumed",
  });
  insertVersion.run({
    txHash: a.v2TxHash,
    unid: a.unid,
    versionNo: 2,
    prevTxHash: a.v1TxHash,
    projectSha256: sha("p2"),
    merkleRoot: sha("m2"),
    blockNumber: 20,
    blockTime: "2026-02-01T00:00:00.000Z",
    status: "committed",
  });
  insertHash.run({ sha256: a.fileHash, txHash: a.v1TxHash, path: "a.txt" });
  insertHash.run({ sha256: a.fileHash, txHash: a.v2TxHash, path: "a.txt" });
  insertHash.run({ sha256: a.fileHash2, txHash: a.v2TxHash, path: "b.txt" });

  const b = FIXTURE.beta;
  insertProject.run({
    unid: b.unid,
    title: "Beta Project",
    sourceUrl: "https://github.com/example/beta",
    ckbAddress: b.address,
    createdAt: "2026-03-01T00:00:00.000Z",
    active: 1,
    liveTxHash: b.txHash,
  });
  insertVersion.run({
    txHash: b.txHash,
    unid: b.unid,
    versionNo: 1,
    prevTxHash: null,
    projectSha256: sha("p3"),
    merkleRoot: sha("m3"),
    blockNumber: 30,
    blockTime: "2026-03-01T00:00:00.000Z",
    status: "committed",
  });
  insertHash.run({ sha256: b.fileHash, txHash: b.txHash, path: "readme.md" });

  const c = FIXTURE.gamma;
  insertProject.run({
    unid: c.unid,
    title: "Gamma Project (withdrawn)",
    sourceUrl: null,
    ckbAddress: c.address,
    createdAt: "2026-04-01T00:00:00.000Z",
    active: 0,
    liveTxHash: null,
  });
  insertVersion.run({
    txHash: c.txHash,
    unid: c.unid,
    versionNo: 1,
    prevTxHash: null,
    projectSha256: sha("p4"),
    merkleRoot: sha("m4"),
    blockNumber: 40,
    blockTime: "2026-04-01T00:00:00.000Z",
    status: "consumed",
  });
  insertHash.run({ sha256: c.fileHash, txHash: c.txHash, path: "old.bin" });

  db.prepare("UPDATE sync_state SET last_block_number = ?, last_block_hash = ? WHERE id = 1").run(
    FIXTURE.syncState.lastBlockNumber,
    FIXTURE.syncState.lastBlockHash,
  );

  return FIXTURE;
}

const EMPTY_PROOF: ProofResult = {
  manifest: null,
  live: null,
  blockNumber: null,
  blockTime: null,
  ownerAddress: null,
};

function manifest(
  extra: Partial<Manifest> & Pick<Manifest, "title" | "project_sha256" | "merkle_root">,
): Manifest {
  return { app: "vericell", v: 1, created: "2026-01-01T00:00:00.000Z", count: 1, ...extra };
}

export const UNINDEXED_MANIFEST: Manifest = manifest({
  title: "Unindexed Project",
  project_sha256: sha("p9"),
  merkle_root: sha("m9"),
});

/**
 * A chain lookup double keyed by the fixture's tx hashes, so `/versions`
 * tests can exercise both the "index" (DB row + chain-supplied manifest) and
 * "chain" (no DB row, pure RPC fallback) paths without a real node.
 */
export function fakeFetchProof(fixture: typeof FIXTURE = FIXTURE): FetchProofFn {
  const table: Record<string, ProofResult> = {
    [fixture.alpha.v1TxHash]: {
      manifest: manifest({
        title: "Alpha Project",
        project_sha256: sha("p1"),
        merkle_root: sha("m1"),
        created: "2026-01-01T00:00:00.000Z",
      }),
      live: false,
      blockNumber: 10n,
      blockTime: new Date("2026-01-01T00:00:00.000Z"),
      ownerAddress: fixture.alpha.address,
    },
    [fixture.alpha.v2TxHash]: {
      manifest: manifest({
        title: "Alpha Project",
        project_sha256: sha("p2"),
        merkle_root: sha("m2"),
        created: "2026-02-01T00:00:00.000Z",
        genesis: fixture.alpha.v1TxHash,
        prev: fixture.alpha.v1TxHash,
      }),
      live: true,
      blockNumber: 20n,
      blockTime: new Date("2026-02-01T00:00:00.000Z"),
      ownerAddress: fixture.alpha.address,
    },
    [fixture.beta.txHash]: {
      manifest: manifest({
        title: "Beta Project",
        project_sha256: sha("p3"),
        merkle_root: sha("m3"),
        created: "2026-03-01T00:00:00.000Z",
        source: "https://github.com/example/beta",
      }),
      live: true,
      blockNumber: 30n,
      blockTime: new Date("2026-03-01T00:00:00.000Z"),
      ownerAddress: fixture.beta.address,
    },
    [fixture.gamma.txHash]: {
      manifest: manifest({
        title: "Gamma Project (withdrawn)",
        project_sha256: sha("p4"),
        merkle_root: sha("m4"),
        created: "2026-04-01T00:00:00.000Z",
      }),
      live: false,
      blockNumber: 40n,
      blockTime: new Date("2026-04-01T00:00:00.000Z"),
      ownerAddress: fixture.gamma.address,
    },
    [fixture.unindexedTxHash]: {
      manifest: UNINDEXED_MANIFEST,
      live: true,
      blockNumber: 99n,
      blockTime: new Date("2026-05-01T00:00:00.000Z"),
      ownerAddress: "ckt1qzda0y0dcnfe2gwzy2v8gy8dsxc6cd8v5uzkxs7lcggwx0v8fyq7unidx",
    },
  };

  return async (txHash: string) => table[txHash] ?? EMPTY_PROOF;
}

export function fakeGetTip(tip = 120n): GetTipFn {
  return async () => tip;
}
