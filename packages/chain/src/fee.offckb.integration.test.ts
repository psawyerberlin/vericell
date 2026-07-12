/**
 * Service-fee integration suite against a real offckb devnet node — see
 * `offckb.integration.test.ts`'s header comment for one-time setup
 * (VERICELL_OFFCKB_PRIVATE_KEY, VERICELL_DEVNET_SCRIPTS_FILE). Skipped
 * entirely unless `OFFCKB=1`.
 *
 * Exercises the real ACP (anyone-can-pay) mechanics `applyServiceFee` and
 * `buildCreateFeeCellsTx`/`buildSweepFeeCellsTx` depend on: topping up a pool
 * cell's capacity requires no signature from the fee owner (RFC 0026's
 * "increase" case), while sweeping the excess back out does.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { encodeManifest, projectHash, merkleRoot, type Manifest } from "core";
import { makeClient } from "./client.js";
import { buildAnchorTx } from "./anchor.js";
import { feeLockFor, buildCreateFeeCellsTx, buildSweepFeeCellsTx } from "./fee.js";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";
const SHANNONS_PER_CKB = 100_000_000n;
const FEE_ENV_VAR = "VERICELL_FEE_ADDRESS_DEVNET";

/** A manifest padded with enough file entries to push the proof cell's
 *  capacity comfortably above the 300 CKB waiver threshold. */
async function largeManifestBytes(title: string): Promise<Uint8Array> {
  // 150 entries pushes the proof cell's capacity (and so the 1% fee) well
  // past the sweep's 61 CKB minimum-cell-capacity floor, not just past the
  // 300 CKB waiver threshold.
  const entries = Array.from({ length: 150 }, (_, i) => ({
    path: `src/some/fairly/long/path/to/file-number-${i}.ts`,
    hash: i.toString(16).padStart(2, "0").repeat(32),
  }));
  const manifest: Manifest = {
    app: "vericell",
    v: 1,
    title,
    created: new Date().toISOString(),
    project_sha256: await projectHash(entries),
    merkle_root: await merkleRoot(entries),
    count: entries.length,
    files: entries.map((e) => ({ p: e.path, h: e.hash })),
  };
  return encodeManifest(manifest);
}

describe.skipIf(!OFFCKB_ENABLED)("service fee against offckb devnet", () => {
  let client: ccc.Client;
  let payerSigner: ccc.SignerCkbPrivateKey;
  let payerLock: ccc.Script;
  let feeOwnerSigner: ccc.SignerCkbPrivateKey;
  let feeOwnerLock: ccc.Script;
  let feeAddress: string;

  beforeAll(async () => {
    const privateKey = globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("OFFCKB=1 requires VERICELL_OFFCKB_PRIVATE_KEY to be set.");
    }
    if (!globalThis.process?.env?.VERICELL_DEVNET_SCRIPTS_FILE) {
      throw new Error("OFFCKB=1 requires VERICELL_DEVNET_SCRIPTS_FILE.");
    }
    client = makeClient("devnet");

    payerSigner = new ccc.SignerCkbPrivateKey(client, privateKey);
    await payerSigner.connect();
    payerLock = (await payerSigner.getRecommendedAddressObj()).script;

    // A second, distinct keypair as the fee recipient — a fresh random key is
    // fine, the devnet miner funds whichever lock the pool cells end up at,
    // not this key directly (it only needs to *sign* the sweep at the end).
    const feeOwnerPrivateKey = ccc.hexFrom(randomBytes(32));
    feeOwnerSigner = new ccc.SignerCkbPrivateKey(client, feeOwnerPrivateKey);
    await feeOwnerSigner.connect();
    feeOwnerLock = (await feeOwnerSigner.getRecommendedAddressObj()).script;
    feeAddress = await feeOwnerSigner.getRecommendedAddress();
  }, 60000);

  afterEach(() => {
    delete process.env[FEE_ENV_VAR];
  });

  it("creates a fee-cell pool, tops it up on anchor (no signature needed), and sweeps it back to the owner", async () => {
    process.env[FEE_ENV_VAR] = feeAddress;

    const feeLock = await feeLockFor(client, "devnet");
    expect(feeLock).toBeDefined();

    // 1. scripts/create-fee-cells.ts equivalent: seed a 2-cell pool.
    const poolCapacity = 100n * SHANNONS_PER_CKB;
    const createTx = await buildCreateFeeCellsTx({
      client,
      payerLock,
      feeLock: feeLock!,
      count: 2,
      capacityPerCellShannons: poolCapacity,
    });
    const createTxHash = await payerSigner.sendTransaction(createTx);
    await client.waitTransaction(createTxHash);

    const poolCellsBefore: ccc.Cell[] = [];
    for await (const cell of client.findCellsByLock(feeLock!, null, true))
      poolCellsBefore.push(cell);
    expect(poolCellsBefore).toHaveLength(2);
    const poolCapacityBefore = poolCellsBefore.reduce((sum, c) => sum + c.cellOutput.capacity, 0n);

    // 2. Anchor a large-enough manifest that a 1% fee is actually due, and
    //    confirm the built transaction really does top up a pool cell
    //    without needing the fee owner's signature at all — only the
    //    payer's signer ever touches this transaction.
    const manifestBytes = await largeManifestBytes("fee-paying project");
    const tx = await buildAnchorTx({ client, lock: payerLock, manifestBytes, network: "devnet" });

    const proofCapacity = tx.outputs[0]!.capacity;
    expect(proofCapacity).toBeGreaterThanOrEqual(300n * SHANNONS_PER_CKB);
    const expectedFee = proofCapacity / 100n;

    // Exactly one extra output beyond the proof cell (+ possible payer
    // change) is locked to the ACP fee lock, with the pool topped up by
    // the expected fee.
    const feeOutputs = tx.outputs.filter((o) => o.lock.eq(feeLock!));
    expect(feeOutputs).toHaveLength(1);

    const txHash = await payerSigner.sendTransaction(tx);
    await client.waitTransaction(txHash);

    const poolCellsAfter: ccc.Cell[] = [];
    for await (const cell of client.findCellsByLock(feeLock!, null, true))
      poolCellsAfter.push(cell);
    expect(poolCellsAfter).toHaveLength(2); // one topped up, one untouched
    const poolCapacityAfter = poolCellsAfter.reduce((sum, c) => sum + c.cellOutput.capacity, 0n);
    expect(poolCapacityAfter - poolCapacityBefore).toBe(expectedFee);

    // 3. scripts/sweep-fee-cells.ts equivalent: sweeping the excess back to
    //    the fee owner *does* require the fee owner's signature (a genuine
    //    capacity decrease at the ACP lock).
    const sweep = await buildSweepFeeCellsTx({
      client,
      feeLock: feeLock!,
      ownerLock: feeOwnerLock,
      reserveCapacityShannons: poolCapacity,
    });
    expect(sweep.tx).toBeDefined();
    expect(sweep.totalSwept).toBe(expectedFee);
    expect(sweep.cellsSwept).toBe(1); // only the topped-up cell has anything above the reserve

    const signedSweep = await feeOwnerSigner.signTransaction(sweep.tx!);
    const sweepTxHash = await client.sendTransaction(signedSweep);
    await client.waitTransaction(sweepTxHash);

    // Outputs: one recreated reserve cell per swept pool cell, then the owner's payout.
    const ownerCell = await client.getCellLive(
      { txHash: sweepTxHash, index: sweep.cellsSwept },
      false,
    );
    expect(ownerCell).toBeDefined();
    expect(ownerCell!.cellOutput.lock.eq(feeOwnerLock)).toBe(true);
    expect(ownerCell!.cellOutput.capacity).toBeGreaterThan(0n);
    expect(ownerCell!.cellOutput.capacity).toBeLessThanOrEqual(expectedFee);

    const poolCellsFinal: ccc.Cell[] = [];
    for await (const cell of client.findCellsByLock(feeLock!, null, true))
      poolCellsFinal.push(cell);
    expect(poolCellsFinal).toHaveLength(2);
    for (const cell of poolCellsFinal) expect(cell.cellOutput.capacity).toBe(poolCapacity);
  }, 180000);
});
