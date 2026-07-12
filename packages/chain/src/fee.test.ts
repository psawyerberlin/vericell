import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { FakeClient } from "./fakeClient.js";
import {
  applyServiceFee,
  feeLockFor,
  isFeeCellContentionError,
  pickFeeCell,
  verifyServiceFeePaid,
  withFeeCellRetry,
} from "./fee.js";

const SHANNONS_PER_CKB = 100_000_000n;
// Must match the fixture FakeClient.getKnownScript returns for KnownScript.AnyoneCanPay.
const ACP_CODE_HASH = "0xe09352af0066f3162287763ce4ddba9af6bfaeab198dc7ab37f8c71c9e68bb5b";
const SECP256K1_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

function secp256k1Lock(argsByte: string): ccc.Script {
  return ccc.Script.from({
    codeHash: SECP256K1_CODE_HASH,
    hashType: "type",
    args: "0x" + argsByte.repeat(20),
  });
}

const ENV_VAR = "VERICELL_FEE_ADDRESS_DEVNET";

describe("service fee (unit, FakeClient)", () => {
  let client: FakeClient;
  let payerLock: ccc.Script;
  let feeOwnerLock: ccc.Script;
  let feeAddress: string;
  let acpLock: ccc.Script;

  beforeEach(() => {
    client = new FakeClient();
    payerLock = secp256k1Lock("11");
    feeOwnerLock = secp256k1Lock("22");
    feeAddress = new ccc.Address(feeOwnerLock, client.addressPrefix).toString();
    acpLock = ccc.Script.from({
      codeHash: ACP_CODE_HASH,
      hashType: "type",
      args: feeOwnerLock.args,
    });
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("feeLockFor derives the ACP lock from the configured address, or undefined when unset", async () => {
    expect(await feeLockFor(client, "devnet")).toBeUndefined();

    process.env[ENV_VAR] = feeAddress;
    const lock = await feeLockFor(client, "devnet");
    expect(lock).toBeDefined();
    expect(lock!.eq(acpLock)).toBe(true);
  });

  it("applyServiceFee is a no-op when no fee address is configured for the network", async () => {
    const tx = ccc.Transaction.from({
      outputs: [{ lock: payerLock, capacity: 400n * SHANNONS_PER_CKB }],
      outputsData: ["0x"],
    });
    const result = await applyServiceFee(client, tx, "devnet");
    expect(result.amount).toBe(0n);
    expect(tx.inputs).toHaveLength(0);
    expect(tx.outputs).toHaveLength(1);
  });

  it("applyServiceFee is a no-op below the 300 CKB waiver threshold, even when configured", async () => {
    process.env[ENV_VAR] = feeAddress;
    client.addLiveCell({
      outPoint: { txHash: "0x" + "aa".repeat(32), index: 0 },
      cellOutput: { capacity: 100n * SHANNONS_PER_CKB, lock: acpLock },
      outputData: "0x",
    });

    const tx = ccc.Transaction.from({
      outputs: [{ lock: payerLock, capacity: 200n * SHANNONS_PER_CKB }],
      outputsData: ["0x"],
    });
    const result = await applyServiceFee(client, tx, "devnet");
    expect(result.amount).toBe(0n);
    expect(tx.inputs).toHaveLength(0);
    expect(tx.outputs).toHaveLength(1);
  });

  it("applyServiceFee adds an ACP input+output pair whose capacity delta equals the fee, above the waiver", async () => {
    process.env[ENV_VAR] = feeAddress;
    const poolOutPoint = { txHash: "0x" + "bb".repeat(32), index: 0 };
    const poolCapacity = 100n * SHANNONS_PER_CKB;
    client.addLiveCell({
      outPoint: poolOutPoint,
      cellOutput: { capacity: poolCapacity, lock: acpLock },
      outputData: "0x",
    });

    const capacity = 1000n * SHANNONS_PER_CKB; // well above the 300 CKB waiver
    const tx = ccc.Transaction.from({
      outputs: [{ lock: payerLock, capacity }],
      outputsData: ["0x"],
    });
    const result = await applyServiceFee(client, tx, "devnet");

    const expectedFee = capacity / 100n; // 1%
    expect(result.amount).toBe(expectedFee);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0]!.previousOutput.txHash).toBe(poolOutPoint.txHash);
    expect(tx.outputs).toHaveLength(2);
    const feeOutput = tx.outputs[1]!;
    expect(feeOutput.lock.eq(acpLock)).toBe(true);
    expect(feeOutput.capacity - poolCapacity).toBe(expectedFee);
    expect(tx.outputsData[1]).toBe("0x");
  });

  it("pickFeeCell throws a helpful error when the pool is empty", async () => {
    await expect(pickFeeCell(client, acpLock)).rejects.toThrow(/create-fee-cells/);
  });

  it("verifyServiceFeePaid accepts a correctly topped-up tx and rejects a stripped one", async () => {
    process.env[ENV_VAR] = feeAddress;
    const poolOutPoint = { txHash: "0x" + "cc".repeat(32), index: 0 };
    client.addLiveCell({
      outPoint: poolOutPoint,
      cellOutput: { capacity: 100n * SHANNONS_PER_CKB, lock: acpLock },
      outputData: "0x",
    });

    const capacity = 1000n * SHANNONS_PER_CKB;
    const tx = ccc.Transaction.from({
      outputs: [{ lock: payerLock, capacity }],
      outputsData: ["0x"],
    });
    await applyServiceFee(client, tx, "devnet");

    const okResult = await verifyServiceFeePaid(client, tx, "devnet");
    expect(okResult.ok).toBe(true);

    // Simulate a client stripping the fee leg back out before signing.
    const stripped = ccc.Transaction.from({
      outputs: [tx.outputs[0]!],
      outputsData: [tx.outputsData[0]!],
    });
    const badResult = await verifyServiceFeePaid(client, stripped, "devnet");
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) {
      expect(badResult.due).toBe(capacity / 100n);
      expect(badResult.paid).toBe(0n);
    }
  });

  it("verifyServiceFeePaid passes trivially when no fee is configured or due", async () => {
    const tx = ccc.Transaction.from({
      outputs: [{ lock: payerLock, capacity: 1000n * SHANNONS_PER_CKB }],
      outputsData: ["0x"],
    });
    expect((await verifyServiceFeePaid(client, tx, "devnet")).ok).toBe(true);

    process.env[ENV_VAR] = feeAddress;
    const smallTx = ccc.Transaction.from({
      outputs: [{ lock: payerLock, capacity: 100n * SHANNONS_PER_CKB }],
      outputsData: ["0x"],
    });
    expect((await verifyServiceFeePaid(client, smallTx, "devnet")).ok).toBe(true);
  });

  it("isFeeCellContentionError matches dead/unknown/resolve failures only", () => {
    expect(isFeeCellContentionError(new Error("TransactionFailedToResolve: Dead"))).toBe(true);
    expect(isFeeCellContentionError(new Error("Unknown input"))).toBe(true);
    expect(isFeeCellContentionError(new Error("insufficient capacity"))).toBe(false);
  });

  it("withFeeCellRetry retries only on contention errors, up to the attempt limit", async () => {
    let calls = 0;
    await expect(
      withFeeCellRetry(async () => {
        calls++;
        throw new Error("Dead cell");
      }, 3),
    ).rejects.toThrow("Dead cell");
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      withFeeCellRetry(async () => {
        calls++;
        throw new Error("some other failure");
      }, 3),
    ).rejects.toThrow("some other failure");
    expect(calls).toBe(1);

    calls = 0;
    const value = await withFeeCellRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("Dead cell");
      return "ok";
    }, 3);
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });
});
