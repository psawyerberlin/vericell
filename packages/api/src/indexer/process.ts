import type Database from "better-sqlite3";
import { ccc } from "@ckb-ccc/ccc";
import type { Manifest } from "core";
import { enqueueWebhookDeliveries } from "../webhooks/dispatch.js";
import type { WebhookEventPayload } from "../webhooks/types.js";
import { detectCandidates, type Candidate } from "./detect.js";

interface VersionRow {
  tx_hash: string;
  unid: string;
  version_no: number;
  status: string;
  project_sha256: string;
}

function projectTitle(db: Database.Database, unid: string): string | null {
  const row = db.prepare("SELECT title FROM projects WHERE unid = ?").get(unid) as
    { title: string } | undefined;
  return row?.title ?? null;
}

function ownerAddress(lock: ccc.ScriptLike, addressPrefix: string): string {
  return new ccc.Address(ccc.Script.from(lock), addressPrefix).toString();
}

function deriveUnid(txHash: string, manifest: Manifest, typeIdArgs: ccc.Hex | null): string {
  return typeIdArgs ?? manifest.genesis ?? txHash;
}

function upsertCandidate(
  db: Database.Database,
  txHash: string,
  candidate: Candidate,
  header: ccc.ClientBlockHeader,
  addressPrefix: string,
): { unid: string } {
  const { manifest, typeIdArgs, lock } = candidate;
  const unid = deriveUnid(txHash, manifest, typeIdArgs);
  const prevTxHash = manifest.prev ?? null;

  let versionNo = 1;
  if (prevTxHash) {
    const prev = db.prepare("SELECT version_no FROM versions WHERE tx_hash = ?").get(prevTxHash) as
      Pick<VersionRow, "version_no"> | undefined;
    versionNo = (prev?.version_no ?? 0) + 1;
  }

  const blockNumber = Number(header.number);
  const blockTime = new Date(Number(header.timestamp)).toISOString();
  const address = ownerAddress(lock, addressPrefix);

  // Captured before the upsert below so a "committed" webhook event fires
  // exactly once per version: the first time the indexer sees this tx (no
  // prior row, or a Phase 5 `pending` placeholder), never on a re-index of
  // an already-committed row.
  const priorStatus = (
    db.prepare("SELECT status FROM versions WHERE tx_hash = ?").get(txHash) as
      Pick<VersionRow, "status"> | undefined
  )?.status;

  db.prepare(
    `INSERT INTO projects (unid, title, source_url, ckb_address, created_at, active, live_tx_hash, live_index)
     VALUES (@unid, @title, @sourceUrl, @ckbAddress, @createdAt, 1, @txHash, 0)
     ON CONFLICT(unid) DO UPDATE SET
       title = excluded.title,
       source_url = excluded.source_url,
       ckb_address = excluded.ckb_address,
       -- A conflict here is normally a later version reusing the same
       -- project unid, whose created_at must stay the genesis version's —
       -- *except* when the existing row is a Phase 5 pending-submit
       -- placeholder for this very genesis version (created_at was only a
       -- submit-time guess then), which this indexed write now supersedes
       -- with the real block timestamp.
       created_at = CASE WHEN @versionNo = 1 THEN excluded.created_at ELSE projects.created_at END,
       active = 1,
       live_tx_hash = excluded.live_tx_hash,
       live_index = 0`,
  ).run({
    unid,
    title: manifest.title,
    sourceUrl: manifest.source ?? null,
    ckbAddress: address,
    createdAt: blockTime,
    txHash,
    versionNo,
  });

  db.prepare(
    `INSERT INTO versions (tx_hash, unid, version_no, prev_tx_hash, project_sha256, merkle_root, block_number, block_time, status)
     VALUES (@txHash, @unid, @versionNo, @prevTxHash, @projectSha256, @merkleRoot, @blockNumber, @blockTime, 'committed')
     ON CONFLICT(tx_hash) DO UPDATE SET
       unid = excluded.unid,
       version_no = excluded.version_no,
       prev_tx_hash = excluded.prev_tx_hash,
       project_sha256 = excluded.project_sha256,
       merkle_root = excluded.merkle_root,
       block_number = excluded.block_number,
       block_time = excluded.block_time,
       status = 'committed'
     WHERE versions.status != 'consumed'`,
  ).run({
    txHash,
    unid,
    versionNo,
    prevTxHash,
    projectSha256: manifest.project_sha256,
    merkleRoot: manifest.merkle_root ?? null,
    blockNumber,
    blockTime,
  });

  if (manifest.files) {
    const insertHash = db.prepare(
      "INSERT OR IGNORE INTO hashes (sha256, tx_hash, path) VALUES (?, ?, ?)",
    );
    for (const file of manifest.files) {
      insertHash.run(file.h, txHash, file.p);
    }
  }

  if (priorStatus !== "committed" && priorStatus !== "consumed") {
    const payload: WebhookEventPayload = {
      event: "committed",
      unid,
      tx_hash: txHash,
      version_no: versionNo,
      project_sha256: manifest.project_sha256,
      title: manifest.title,
      block_number: blockNumber,
      block_time: blockTime,
    };
    enqueueWebhookDeliveries(db, "committed", unid, payload);
  }

  return { unid };
}

function markConsumed(
  db: Database.Database,
  prevTxHash: string,
  candidates: Candidate[],
  successorTxHash: string,
  header: ccc.ClientBlockHeader,
): void {
  const prevRow = db
    .prepare(
      "SELECT tx_hash, unid, version_no, status, project_sha256 FROM versions WHERE tx_hash = ?",
    )
    .get(prevTxHash) as VersionRow | undefined;
  if (!prevRow || prevRow.status === "consumed") return;

  const consumedAtBlock = Number(header.number);
  const blockTime = new Date(Number(header.timestamp)).toISOString();

  db.prepare(
    "UPDATE versions SET status = 'consumed', consumed_at_block = ? WHERE tx_hash = ?",
  ).run(consumedAtBlock, prevTxHash);

  const title = projectTitle(db, prevRow.unid);
  enqueueWebhookDeliveries(db, "consumed", prevRow.unid, {
    event: "consumed",
    unid: prevRow.unid,
    tx_hash: prevTxHash,
    version_no: prevRow.version_no,
    project_sha256: prevRow.project_sha256,
    title,
    block_number: consumedAtBlock,
    block_time: blockTime,
  });

  const successor = candidates.find((c) => c.manifest.prev === prevTxHash);
  if (successor) {
    db.prepare(
      "UPDATE projects SET active = 1, live_tx_hash = ?, live_index = 0 WHERE unid = ?",
    ).run(successorTxHash, prevRow.unid);

    enqueueWebhookDeliveries(db, "superseded", prevRow.unid, {
      event: "superseded",
      unid: prevRow.unid,
      tx_hash: prevTxHash,
      version_no: prevRow.version_no,
      project_sha256: prevRow.project_sha256,
      title,
      block_number: consumedAtBlock,
      block_time: blockTime,
      successor_tx_hash: successorTxHash,
    });
  } else {
    db.prepare("UPDATE projects SET active = 0, live_tx_hash = NULL WHERE unid = ?").run(
      prevRow.unid,
    );
  }
}

/**
 * Process one already-fetched block: upsert every VeriCell output as a
 * project/version(/hashes), then mark any input that consumed a previously
 * live proof cell as `consumed`, linking a same-tx successor if present or
 * else deactivating the project (withdraw). Runs in a single DB transaction
 * so a block is indexed atomically.
 */
export function processBlock(
  db: Database.Database,
  block: ccc.ClientBlock,
  typeIdInfo: ccc.ScriptInfo,
  addressPrefix: string,
): void {
  const run = db.transaction(() => {
    for (const tx of block.transactions) {
      const txHash = tx.hash();
      const candidates = detectCandidates(tx, typeIdInfo);

      for (const candidate of candidates) {
        upsertCandidate(db, txHash, candidate, block.header, addressPrefix);
      }

      for (const input of tx.inputs) {
        // Every builder in `chain` places the proof cell at output index 0
        // (capacity/change outputs come after). An input spending index
        // 1+ of a tx we know is just that tx's change cell being reused as
        // plain capacity funding by a *later*, unrelated anchor — not a
        // consumption of the proof cell itself.
        if (Number(input.previousOutput.index) !== 0) continue;
        markConsumed(db, input.previousOutput.txHash, candidates, txHash, block.header);
      }
    }
  });
  run();
}
