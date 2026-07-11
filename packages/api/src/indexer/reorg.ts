import type Database from "better-sqlite3";
import type { IndexerClient } from "./types.js";

export interface SyncState {
  lastBlockNumber: bigint | null;
  lastBlockHash: string | null;
}

interface SyncStateRow {
  last_block_number: number | null;
  last_block_hash: string | null;
}

export function getSyncState(db: Database.Database): SyncState {
  const row = db
    .prepare("SELECT last_block_number, last_block_hash FROM sync_state WHERE id = 1")
    .get() as SyncStateRow | undefined;
  return {
    lastBlockNumber: row?.last_block_number == null ? null : BigInt(row.last_block_number),
    lastBlockHash: row?.last_block_hash ?? null,
  };
}

export function setSyncState(
  db: Database.Database,
  blockNumber: bigint,
  blockHash: string | null,
): void {
  db.prepare("UPDATE sync_state SET last_block_number = ?, last_block_hash = ? WHERE id = 1").run(
    Number(blockNumber),
    blockHash,
  );
}

/**
 * Reorg rollback: delete/recompute rows with `block_number` past `forkPoint`
 * and rewind `sync_state` to it. Pending versions (`block_number IS NULL`,
 * not yet seen on chain) are untouched — `block_number > ?` never matches NULL.
 *
 * A version consumed by a transaction that is itself being rolled back must
 * have its `consumed` status undone, even though the version's own row
 * survives (it was created at or before `forkPoint`) — `consumed_at_block`
 * exists precisely to make that reversible without re-scanning the chain.
 * Surviving rows consumed at or before `forkPoint` (a real supersede/withdraw
 * unaffected by this reorg) are left untouched.
 */
function rollbackTo(db: Database.Database, forkPoint: bigint): void {
  const fork = Number(forkPoint);
  const run = db.transaction(() => {
    const deleted = new Set(
      (
        db.prepare("SELECT DISTINCT unid FROM versions WHERE block_number > ?").all(fork) as {
          unid: string;
        }[]
      ).map((r) => r.unid),
    );
    const unconsumed = new Set(
      (
        db.prepare("SELECT DISTINCT unid FROM versions WHERE consumed_at_block > ?").all(fork) as {
          unid: string;
        }[]
      ).map((r) => r.unid),
    );

    db.prepare(
      "DELETE FROM hashes WHERE tx_hash IN (SELECT tx_hash FROM versions WHERE block_number > ?)",
    ).run(fork);
    db.prepare("DELETE FROM versions WHERE block_number > ?").run(fork);
    db.prepare(
      "UPDATE versions SET status = 'committed', consumed_at_block = NULL WHERE consumed_at_block > ?",
    ).run(fork);

    for (const unid of new Set([...deleted, ...unconsumed])) {
      const live = db
        .prepare(
          "SELECT tx_hash FROM versions WHERE unid = ? AND status != 'consumed' ORDER BY version_no DESC LIMIT 1",
        )
        .get(unid) as { tx_hash: string } | undefined;

      if (live) {
        db.prepare(
          "UPDATE projects SET active = 1, live_tx_hash = ?, live_index = 0 WHERE unid = ?",
        ).run(live.tx_hash, unid);
        continue;
      }

      const anySurvivor = db.prepare("SELECT 1 FROM versions WHERE unid = ? LIMIT 1").get(unid);
      if (!anySurvivor) {
        db.prepare("DELETE FROM projects WHERE unid = ?").run(unid);
      } else {
        db.prepare("UPDATE projects SET active = 0, live_tx_hash = NULL WHERE unid = ?").run(unid);
      }
    }
  });
  run();
}

/**
 * Roll back a fixed depth (`ClaudeCodeInstruction.md` Phase 3: "roll back N
 * blocks") from `cursor` and rewind `sync_state` to the new fork point. If
 * the reorg is deeper than `depth`, the next poll iteration will detect the
 * parent-hash mismatch again and roll back further — self-correcting,
 * bounded below by block 0.
 */
export async function rollback(
  db: Database.Database,
  client: IndexerClient,
  cursor: bigint,
  depth: bigint,
): Promise<bigint> {
  const forkPoint = cursor > depth ? cursor - depth : 0n;
  rollbackTo(db, forkPoint);

  let hash: string | null = null;
  if (forkPoint > 0n) {
    const block = await client.getBlockByNumber(forkPoint);
    hash = block?.header.hash ?? null;
  }
  setSyncState(db, forkPoint, hash);
  return forkPoint;
}
