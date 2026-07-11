import { describe, expect, it } from "vitest";
import { openDb } from "../db/open.js";
import { Indexer } from "./indexer.js";
import { FakeChainClient } from "./fakeChainClient.js";
import { anchorTx, manifestBytesFor } from "./testFixtures.js";

describe("indexer kill/restart cursor resume", () => {
  it("a fresh Indexer instance against the same DB resumes from sync_state, not from scratch", async () => {
    const db = openDb(":memory:");
    const client = new FakeChainClient();

    const txA = anchorTx(await manifestBytesFor("Project R"));
    client.addBlock([txA]);

    // "Process 1": indexes block 1, then is killed (instance discarded, no stop()).
    const indexer1 = new Indexer({ db, client, startBlock: 0n });
    await indexer1.pollOnce();

    const stateAfterFirst = db
      .prepare("SELECT last_block_number, last_block_hash FROM sync_state")
      .get() as { last_block_number: number; last_block_hash: string };
    expect(stateAfterFirst.last_block_number).toBe(1);

    let versionCount = (db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n;
    expect(versionCount).toBe(1);

    // Add a second block while "process 1" is down.
    const txB = anchorTx(await manifestBytesFor("Project S"));
    client.addBlock([txB]);

    // "Process 2": a brand new Indexer instance (as after a restart), same DB file/client.
    const indexer2 = new Indexer({ db, client, startBlock: 0n });
    await indexer2.pollOnce();

    const stateAfterRestart = db
      .prepare("SELECT last_block_number, last_block_hash FROM sync_state")
      .get() as { last_block_number: number; last_block_hash: string };
    expect(stateAfterRestart.last_block_number).toBe(2);

    // Block 1 was not reprocessed a second time — still exactly one row for Project R.
    versionCount = (db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }).n;
    expect(versionCount).toBe(2);

    const titles = db
      .prepare("SELECT title FROM projects ORDER BY title")
      .all()
      .map((r) => (r as { title: string }).title);
    expect(titles).toEqual(["Project R", "Project S"]);

    db.close();
  });

  it("start()/stop() halts the poll loop cleanly and a later Indexer resumes from where it left off", async () => {
    const db = openDb(":memory:");
    const client = new FakeChainClient();

    const txA = anchorTx(await manifestBytesFor("Project T"));
    client.addBlock([txA]);

    const indexer1 = new Indexer({ db, client, startBlock: 0n, pollIntervalMs: 10 });
    indexer1.start();
    // Give the loop time to run at least one iteration, then stop it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await indexer1.stop();

    const midState = db.prepare("SELECT last_block_number FROM sync_state").get() as {
      last_block_number: number;
    };
    expect(midState.last_block_number).toBe(1);

    const txB = anchorTx(await manifestBytesFor("Project U"));
    client.addBlock([txB]);

    const indexer2 = new Indexer({ db, client, startBlock: 0n });
    await indexer2.pollOnce();

    const finalState = db.prepare("SELECT last_block_number FROM sync_state").get() as {
      last_block_number: number;
    };
    expect(finalState.last_block_number).toBe(2);

    db.close();
  });
});
