/**
 * Phase 3 acceptance: indexer integration suite against a real offckb devnet
 * node. Reuses the same devnet setup as `chain`'s offckb suite — see that
 * file's header comment for the full setup steps. In short:
 *
 *   1. `offckb node` (RPC proxy at http://127.0.0.1:28114 by default).
 *   2. `VERICELL_OFFCKB_PRIVATE_KEY` = a funded devnet account's private key.
 *   3. `VERICELL_DEVNET_SCRIPTS_FILE` = path to
 *      `offckb system-scripts --export-style ccc --network devnet` output.
 *   4. `OFFCKB=1 pnpm --filter api test` (or `pnpm --filter api test:offckb`)
 *
 * Skipped entirely unless `OFFCKB=1`. Assertions are scoped to this run's
 * own anchored transactions (a random tag distinguishes them) rather than
 * global table counts, since a long-lived local devnet accumulates cells
 * from earlier test runs (this suite's and `chain`'s).
 *
 * `pollOnce()` here walks every block from its `startBlock` to tip (see
 * `indexer/process.ts`'s DECISIONS.md entry on the full-chain scan). On a
 * devnet instance that has been running and accumulating blocks for a
 * while, indexing from genesis (the default `startBlock: 0n`) can take
 * longer than a short test timeout — set `INDEXER_START_BLOCK` (same env
 * var `indexer/run.ts` reads for testnet/mainnet) to skip straight to a
 * recent height on such a devnet; the timeout below is also generous enough
 * to cover a genesis walk on a moderately-aged local devnet without it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { encodeManifest, projectHash, merkleRoot, sha256Hex, type Manifest } from "core";
import { makeClient, buildAnchorTx } from "chain";
import { openDb } from "../db/open.js";
import { Indexer } from "./indexer.js";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";

async function manifestBytesFor(
  title: string,
  fileTag: string,
  extra?: Partial<Manifest>,
): Promise<Uint8Array> {
  const fileHash = await sha256Hex(new TextEncoder().encode(fileTag));
  const entries = [{ path: "file.txt", hash: fileHash }];
  const manifest: Manifest = {
    app: "vericell",
    v: 1,
    title,
    created: new Date().toISOString(),
    project_sha256: await projectHash(entries),
    merkle_root: await merkleRoot(entries),
    count: entries.length,
    files: entries.map((e) => ({ p: e.path, h: e.hash })),
    ...extra,
  };
  return encodeManifest(manifest);
}

interface ProjectRow {
  active: number;
  live_tx_hash: string | null;
  title: string;
}
interface VersionRow {
  tx_hash: string;
  version_no: number;
  prev_tx_hash: string | null;
  status: string;
}
interface HashRow {
  tx_hash: string;
  path: string;
}

describe.skipIf(!OFFCKB_ENABLED)("indexer against offckb devnet", () => {
  let client: ccc.Client;
  let signer: ccc.SignerCkbPrivateKey;
  let lock: ccc.Script;
  const runTag = Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const privateKey = globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_OFFCKB_PRIVATE_KEY to be set to a funded devnet account's private key.",
      );
    }
    if (!globalThis.process?.env?.VERICELL_DEVNET_SCRIPTS_FILE) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_DEVNET_SCRIPTS_FILE (see this file's header comment).",
      );
    }
    client = makeClient("devnet");
    signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    await signer.connect();
    lock = (await signer.getRecommendedAddressObj()).script;
  }, 30000);

  it("indexes 3 anchored projects (one with 2 versions) to tip", async () => {
    const p1Data = await manifestBytesFor(`Phase3 P1 ${runTag}`, `${runTag}:p1`);
    const p1Tx = await buildAnchorTx({ client, lock, manifestBytes: p1Data });
    const p1TxHash = await signer.sendTransaction(p1Tx);
    await client.waitTransaction(p1TxHash);

    const p2Data = await manifestBytesFor(`Phase3 P2 ${runTag}`, `${runTag}:p2`);
    const p2Tx = await buildAnchorTx({ client, lock, manifestBytes: p2Data });
    const p2TxHash = await signer.sendTransaction(p2Tx);
    await client.waitTransaction(p2TxHash);

    const p3v1Data = await manifestBytesFor(`Phase3 P3 ${runTag}`, `${runTag}:p3v1`);
    const p3v1Tx = await buildAnchorTx({ client, lock, manifestBytes: p3v1Data });
    const p3v1TxHash = await signer.sendTransaction(p3v1Tx);
    await client.waitTransaction(p3v1TxHash);

    const p3v2Data = await manifestBytesFor(`Phase3 P3 v2 ${runTag}`, `${runTag}:p3v2`, {
      genesis: p3v1TxHash,
      prev: p3v1TxHash,
    });
    const p3v2Tx = await buildAnchorTx({
      client,
      lock,
      manifestBytes: p3v2Data,
      prevOutPoint: { txHash: p3v1TxHash, index: 0 },
    });
    const p3v2TxHash = await signer.sendTransaction(p3v2Tx);
    await client.waitTransaction(p3v2TxHash);

    const startBlock = BigInt(globalThis.process?.env?.INDEXER_START_BLOCK ?? 0);
    const db = openDb(":memory:");
    const indexer = new Indexer({ db, client, startBlock });
    await indexer.pollOnce();

    const project1 = db.prepare("SELECT * FROM projects WHERE unid = ?").get(p1TxHash) as
      ProjectRow | undefined;
    expect(project1).toBeDefined();
    expect(project1!.active).toBe(1);
    expect(project1!.live_tx_hash).toBe(p1TxHash);
    expect(project1!.title).toBe(`Phase3 P1 ${runTag}`);

    const project2 = db.prepare("SELECT * FROM projects WHERE unid = ?").get(p2TxHash) as
      ProjectRow | undefined;
    expect(project2).toBeDefined();
    expect(project2!.active).toBe(1);
    expect(project2!.live_tx_hash).toBe(p2TxHash);

    const project3 = db.prepare("SELECT * FROM projects WHERE unid = ?").get(p3v1TxHash) as
      ProjectRow | undefined;
    expect(project3).toBeDefined();
    expect(project3!.active).toBe(1);
    expect(project3!.live_tx_hash).toBe(p3v2TxHash);

    const project3Versions = db
      .prepare(
        "SELECT tx_hash, version_no, prev_tx_hash, status FROM versions WHERE unid = ? ORDER BY version_no",
      )
      .all(p3v1TxHash) as VersionRow[];
    expect(project3Versions).toHaveLength(2);
    expect(project3Versions[0]!.tx_hash).toBe(p3v1TxHash);
    expect(project3Versions[0]!.version_no).toBe(1);
    expect(project3Versions[0]!.status).toBe("consumed");
    expect(project3Versions[1]!.tx_hash).toBe(p3v2TxHash);
    expect(project3Versions[1]!.version_no).toBe(2);
    expect(project3Versions[1]!.prev_tx_hash).toBe(p3v1TxHash);
    expect(project3Versions[1]!.status).toBe("committed");

    // Backward hash lookup: project1's unique file hash resolves back to it.
    const p1FileHash = await sha256Hex(new TextEncoder().encode(`${runTag}:p1`));
    const hashRows = db
      .prepare("SELECT tx_hash, path FROM hashes WHERE sha256 = ?")
      .all(p1FileHash) as HashRow[];
    expect(hashRows).toHaveLength(1);
    expect(hashRows[0]!.tx_hash).toBe(p1TxHash);
    expect(hashRows[0]!.path).toBe("file.txt");

    db.close();
  }, 300000);
});
