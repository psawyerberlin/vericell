import { describe, expect, it } from "vitest";
import { openDb } from "../db/open.js";
import { Indexer } from "./indexer.js";
import { FakeChainClient } from "./fakeChainClient.js";
import { anchorTx, manifestBytesFor, withdrawTx } from "./testFixtures.js";

interface VersionRow {
  tx_hash: string;
  status: string;
}
interface ProjectRow {
  active: number;
  live_tx_hash: string | null;
}

describe("indexer reorg handling (mocked client)", () => {
  it("rolls back a superseded version and undoes its consumption when that block is reorged away", async () => {
    const db = openDb(":memory:");
    const client = new FakeChainClient();
    // reorgDepth=1 so a 1-block-deep reorg rolls back to exactly the fork point.
    const indexer = new Indexer({ db, client, reorgDepth: 1n, startBlock: 0n });

    const txA = anchorTx(await manifestBytesFor("Project P"));
    client.addBlock([txA]);
    const txAHash = txA.hash();

    const txB = anchorTx(
      await manifestBytesFor("Project P v2", { genesis: txAHash, prev: txAHash }),
      { txHash: txAHash, index: 0 },
    );
    client.addBlock([txB]);
    const txBHash = txB.hash();

    await indexer.pollOnce();

    let versions = db
      .prepare("SELECT tx_hash, status FROM versions ORDER BY version_no")
      .all() as VersionRow[];
    expect(versions).toHaveLength(2);
    expect(versions[0]!.tx_hash).toBe(txAHash);
    expect(versions[0]!.status).toBe("consumed");
    expect(versions[1]!.tx_hash).toBe(txBHash);
    expect(versions[1]!.status).toBe("committed");

    let project = db.prepare("SELECT active, live_tx_hash FROM projects").get() as ProjectRow;
    expect(project.active).toBe(1);
    expect(project.live_tx_hash).toBe(txBHash);

    // Reorg: the fork drops block 2 (txB) and replaces it with a withdraw of txA instead.
    client.reorgAfter(1n);
    const txC = withdrawTx({ txHash: txAHash, index: 0 });
    client.addBlock([txC]);
    const txCHash = txC.hash();

    await indexer.pollOnce();

    versions = db.prepare("SELECT tx_hash, status FROM versions").all() as VersionRow[];
    expect(versions).toHaveLength(1);
    expect(versions[0]!.tx_hash).toBe(txAHash);
    // Consumed again — but by txC (the withdraw on the new fork), not the rolled-back txB.
    expect(versions[0]!.status).toBe("consumed");

    project = db.prepare("SELECT active, live_tx_hash FROM projects").get() as ProjectRow;
    expect(project.active).toBe(0);
    expect(project.live_tx_hash).toBeNull();

    const state = db.prepare("SELECT last_block_number, last_block_hash FROM sync_state").get() as {
      last_block_number: number;
      last_block_hash: string;
    };
    expect(state.last_block_number).toBe(2);
    expect(txCHash).toBeTruthy(); // sanity: computed, not asserted further

    db.close();
  });

  it("detects a same-height reorg even when the chain length hasn't grown past the recorded tip", async () => {
    const db = openDb(":memory:");
    const client = new FakeChainClient();
    const indexer = new Indexer({ db, client, reorgDepth: 1n, startBlock: 0n });

    const txA = anchorTx(await manifestBytesFor("Project Q"));
    client.addBlock([txA]);
    await indexer.pollOnce();

    let project = db.prepare("SELECT title FROM projects").get() as { title: string };
    expect(project.title).toBe("Project Q");

    // Same-height reorg: replace block 1 with a different project entirely.
    client.reorgAfter(0n);
    const txA2 = anchorTx(await manifestBytesFor("Project Q replaced"));
    client.addBlock([txA2]);

    await indexer.pollOnce();

    const projects = db.prepare("SELECT title FROM projects").all() as { title: string }[];
    expect(projects).toHaveLength(1);
    expect(projects[0]!.title).toBe("Project Q replaced");

    db.close();
  });
});
