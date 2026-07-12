import { ccc } from "@ckb-ccc/ccc";
import { computeFee, getFeeAddress, type Network } from "core";
import { DEFAULT_FEE_RATE } from "./constants.js";
import { PURE_CAPACITY_FILTER } from "./filters.js";
import { reserveSighashWitness } from "./witness.js";

const MIN_CELL_CAPACITY_SHANNONS = 61n * 100_000_000n;

/**
 * Derives this network's ACP (anyone-can-pay) fee-collection lock from its
 * configured `VERICELL_FEE_ADDRESS_<NETWORK>` (core's `getFeeAddress`) — same
 * lock args (the blake160 hash) as that address's ordinary secp256k1 lock,
 * but under the ACP code hash, so anchoring transactions can top up its
 * capacity without the fee recipient's signature (RFC 0026: an ACP-locked
 * cell may be spent without a signature as long as its own lock's total
 * capacity does not decrease). Returns `undefined` if no fee address is
 * configured for `network` — the caller's signal that fee collection is
 * fully disabled there.
 */
export async function feeLockFor(
  client: ccc.Client,
  network: Network,
): Promise<ccc.Script | undefined> {
  const address = getFeeAddress(network);
  if (!address) return undefined;
  const addr = await ccc.Address.fromString(address, client);
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  return ccc.Script.from({
    codeHash: acpInfo.codeHash,
    hashType: acpInfo.hashType,
    args: addr.script.args,
  });
}

/** How many live candidates to sample before picking one to top up (see {@link pickFeeCell}). */
const FEE_CELL_CANDIDATES = 5;

/**
 * Picks a live fee-collection cell at `feeLock` to top up — one of the pool
 * created by `scripts/create-fee-cells.ts`, chosen at random among up to
 * {@link FEE_CELL_CANDIDATES} live candidates. Randomizing (rather than
 * always taking the first result) spreads concurrent anchors across
 * different pool cells, reducing — though on a small pool not eliminating —
 * the chance two anchors race to top up the same cell and one loses at
 * broadcast time to a double-spend; callers that build *and* broadcast in
 * one step (the custodial routes) should retry the whole build on that
 * specific failure (see `withFeeCellRetry`).
 */
export async function pickFeeCell(client: ccc.Client, feeLock: ccc.ScriptLike): Promise<ccc.Cell> {
  const candidates: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(feeLock, null, true)) {
    candidates.push(cell);
    if (candidates.length >= FEE_CELL_CANDIDATES) break;
  }
  if (candidates.length === 0) {
    throw new Error(
      "No fee-collection cell found at the configured fee address's ACP lock — " +
        "run scripts/create-fee-cells.ts to set up the pool first.",
    );
  }
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

async function requiredFee(
  client: ccc.Client,
  network: Network,
  capacityShannons: bigint,
): Promise<{ amount: bigint; feeLock?: ccc.Script }> {
  const amount = computeFee(capacityShannons);
  if (amount === 0n) return { amount: 0n };
  const feeLock = await feeLockFor(client, network);
  if (!feeLock) return { amount: 0n };
  return { amount, feeLock };
}

export interface FeeApplication {
  /** Service fee actually applied, in shannons (0 if waived or not configured for this network). */
  amount: bigint;
  /** The pool cell topped up, present only when `amount > 0n`. */
  cell?: ccc.Cell;
}

/**
 * Appends a service-fee top-up leg to `tx` **in place**, if one is due:
 * 1% of `tx.outputs[0]`'s capacity (the new proof cell), waived below 300
 * CKB, and only when `network` has a fee address configured at all. Adds a
 * live pool cell (picked via {@link pickFeeCell}) as an input and a
 * same-lock, same-shape output with capacity increased by the fee — no type
 * script, empty data, matching what `scripts/create-fee-cells.ts` creates.
 * Must be called before `completeInputsByCapacity`/`completeFeeBy` so the
 * payer's own inputs are collected to cover the fee amount too.
 */
export async function applyServiceFee(
  client: ccc.Client,
  tx: ccc.Transaction,
  network: Network,
): Promise<FeeApplication> {
  const output0 = tx.outputs[0];
  if (!output0) return { amount: 0n };

  const { amount, feeLock } = await requiredFee(client, network, output0.capacity);
  if (amount === 0n || !feeLock) return { amount: 0n };

  const cell = await pickFeeCell(client, feeLock);
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  await tx.addCellDepInfos(client, acpInfo.cellDeps);
  tx.addInput({ previousOutput: cell.outPoint });
  tx.addOutput({ lock: cell.cellOutput.lock, capacity: cell.cellOutput.capacity + amount }, "0x");

  return { amount, cell };
}

/** Sum of `tx.outputs`/resolved-`tx.inputs` capacities locked to `feeLock` — the net capacity flowing into it. */
async function netFeeLockDelta(
  client: ccc.Client,
  tx: ccc.Transaction,
  feeLock: ccc.ScriptLike,
): Promise<bigint> {
  const feeLockScript = ccc.Script.from(feeLock);

  let outputSum = 0n;
  for (const output of tx.outputs) {
    if (output.lock.eq(feeLockScript)) outputSum += output.capacity;
  }

  let inputSum = 0n;
  for (const input of tx.inputs) {
    const cell = await client.getCell(input.previousOutput);
    if (cell && cell.cellOutput.lock.eq(feeLockScript)) inputSum += cell.cellOutput.capacity;
  }

  return outputSum - inputSum;
}

export type FeeVerification = { ok: true; due: bigint } | { ok: false; due: bigint; paid: bigint };

/**
 * Verifies a (signed, about-to-be-broadcast) transaction actually carries
 * the service fee due for its `outputs[0]` capacity, on `network` — used by
 * `POST /proofs/submit` to reject a transaction that stripped the fee leg
 * `applyServiceFee` added at `/proofs/prepare` time before signing it.
 * `ok: true, due: 0n` whenever no fee is owed at all (waived amount, or no
 * fee address configured for `network` — nothing to enforce).
 */
export async function verifyServiceFeePaid(
  client: ccc.Client,
  tx: ccc.Transaction,
  network: Network,
): Promise<FeeVerification> {
  const output0 = tx.outputs[0];
  const capacity = output0 ? output0.capacity : 0n;
  const { amount, feeLock } = await requiredFee(client, network, capacity);
  if (amount === 0n || !feeLock) return { ok: true, due: 0n };

  const paid = await netFeeLockDelta(client, tx, feeLock);
  return paid >= amount ? { ok: true, due: amount } : { ok: false, due: amount, paid };
}

/** Matches the CKB node's rejection when a referenced input is no longer live — another tx consumed it first. */
const RESOLVE_CONTENTION_RE = /(dead|unknown|resolve)/i;

export function isFeeCellContentionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RESOLVE_CONTENTION_RE.test(message);
}

/**
 * Retries `build` (which must pick its own fee cell fresh each attempt —
 * `applyServiceFee` does this via {@link pickFeeCell}'s randomization) up to
 * `attempts` times when it fails with what looks like fee-cell contention: a
 * concurrent anchor won the race to spend the same pool cell first. Used by
 * the custodial routes, which build *and* broadcast in one server-side step
 * and so can safely rebuild-and-resend on this specific failure.
 */
export async function withFeeCellRetry<T>(build: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await build();
    } catch (err) {
      lastErr = err;
      if (!isFeeCellContentionError(err)) throw err;
    }
  }
  throw lastErr;
}

// ===========================================================================
// Pool management — scripts/create-fee-cells.ts and scripts/sweep-fee-cells.ts
// ===========================================================================

export interface BuildCreateFeeCellsTxParams {
  client: ccc.Client;
  /** Lock script funding the new pool cells (the operator's own wallet). */
  payerLock: ccc.ScriptLike;
  /** The ACP fee-collection lock the new cells are created at — see {@link feeLockFor}. */
  feeLock: ccc.ScriptLike;
  count: number;
  capacityPerCellShannons: bigint;
  feeRate?: ccc.NumLike;
}

/**
 * Builds an unsigned transaction creating `count` fresh ACP fee-collection
 * cells (no type script, empty data — the exact shape {@link applyServiceFee}
 * expects to find and top up), each at `capacityPerCellShannons`, funded from
 * `payerLock`. Run once per network by `scripts/create-fee-cells.ts` before
 * fee collection can work at all (see {@link pickFeeCell}'s error otherwise).
 */
export async function buildCreateFeeCellsTx(
  params: BuildCreateFeeCellsTxParams,
): Promise<ccc.Transaction> {
  const { client, payerLock, feeLock, count, capacityPerCellShannons, feeRate } = params;

  const tx = ccc.Transaction.from({});
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  await tx.addCellDepInfos(client, acpInfo.cellDeps);
  for (let i = 0; i < count; i++) {
    tx.addOutput({ lock: feeLock, capacity: capacityPerCellShannons }, "0x");
  }

  const signer = new ccc.SignerCkbScriptReadonly(client, payerLock);
  await tx.completeInputsByCapacity(signer, undefined, PURE_CAPACITY_FILTER);
  await reserveSighashWitness(tx, payerLock, client);
  await tx.completeFeeBy(signer, feeRate ?? DEFAULT_FEE_RATE);

  return tx;
}

export interface BuildSweepFeeCellsTxParams {
  client: ccc.Client;
  /** The ACP fee-collection lock to sweep — see {@link feeLockFor}. */
  feeLock: ccc.ScriptLike;
  /** Where the swept-out capacity goes — the operator's plain wallet address/lock. */
  ownerLock: ccc.ScriptLike;
  /**
   * Capacity left behind in each swept cell, re-created at `feeLock` so fee
   * collection keeps working after the sweep — only the excess above this
   * per-cell is swept out. Defaults to leaving each cell untouched (0
   * swept) unless its capacity exceeds this amount.
   */
  reserveCapacityShannons: bigint;
  feeRate?: ccc.NumLike;
}

export interface SweepFeeCellsResult {
  /** `undefined` when there was nothing above `reserveCapacityShannons` to sweep. */
  tx?: ccc.Transaction;
  /** Total shannons moved to `ownerLock` (before the network fee, which reduces it further). */
  totalSwept: bigint;
  cellsSwept: number;
}

/**
 * Builds an unsigned transaction consolidating every fee-collection cell's
 * capacity above `reserveCapacityShannons` to `ownerLock`, in one tx: each
 * swept cell is both an input and a same-lock output re-created at exactly
 * `reserveCapacityShannons` (keeping the pool alive for further top-ups),
 * and a single extra output sends the accumulated excess to `ownerLock`.
 *
 * Deliberately does **not** use `Transaction.completeFeeBy`: with every
 * input already resolved to a known ACP cell, letting it auto-collect
 * capacity for the fee could silently consume yet another pool cell as a
 * pure fee source instead of drawing the fee from the swept excess itself.
 * The network fee is instead estimated directly and subtracted from the
 * owner's own output, so the transaction's accounting matches exactly what
 * this function reports.
 *
 * The result is unsigned: spending each swept cell for less than its full
 * capacity is a *decrease* under the ACP lock's rule (RFC 0026), which does
 * require a valid signature from the fee address's own key — the caller
 * (`scripts/sweep-fee-cells.ts`) signs it with a locally supplied key. Real
 * signature verification inside the ACP script needs `secp256k1_data` as a
 * cell dep; on testnet/mainnet the ACP script's own registered cell dep is a
 * dep *group* that already bundles it, but at least one devnet fixture
 * (`offckb system-scripts`) registers it as a bare code cell without that
 * group — so this always adds `Secp256k1Blake160`'s cell dep too (which
 * bundles `secp256k1_data` the same way sighash spends do), redundant but
 * harmless where the ACP dep already includes it.
 */
export async function buildSweepFeeCellsTx(
  params: BuildSweepFeeCellsTxParams,
): Promise<SweepFeeCellsResult> {
  const { client, feeLock, ownerLock, reserveCapacityShannons, feeRate } = params;
  const feeLockScript = ccc.Script.from(feeLock);

  const cellsToSweep: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(feeLockScript, null, true)) {
    if (cell.cellOutput.type) continue; // pool cells never carry a type script
    if (cell.cellOutput.capacity > reserveCapacityShannons) cellsToSweep.push(cell);
  }
  if (cellsToSweep.length === 0) {
    return { totalSwept: 0n, cellsSwept: 0 };
  }

  const tx = ccc.Transaction.from({});
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  await tx.addCellDepInfos(client, acpInfo.cellDeps);
  const secp256k1Info = await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  await tx.addCellDepInfos(client, secp256k1Info.cellDeps);

  let totalSwept = 0n;
  for (const cell of cellsToSweep) {
    tx.addInput({ previousOutput: cell.outPoint });
    tx.addOutput({ lock: feeLockScript, capacity: reserveCapacityShannons }, "0x");
    totalSwept += cell.cellOutput.capacity - reserveCapacityShannons;
  }

  // Placeholder capacity — added now (not after estimating the fee) so the
  // fee estimate below already reflects this output's true byte size; a
  // u64 capacity field is fixed-width, so overwriting the value in place
  // afterward doesn't change the transaction's size.
  const ownerOutputIndex = tx.addOutput({ lock: ownerLock, capacity: totalSwept }, "0x") - 1;
  await reserveSighashWitness(tx, feeLockScript, client);

  const fee = tx.estimateFee(feeRate ?? DEFAULT_FEE_RATE);
  const ownerCapacity = totalSwept - fee;
  if (ownerCapacity < MIN_CELL_CAPACITY_SHANNONS) {
    throw new Error(
      `Swept amount (${totalSwept} shannons) minus the network fee (${fee} shannons) is below ` +
        `the minimum cell capacity — accumulate more fees before sweeping, or lower --reserve-ckb.`,
    );
  }
  tx.outputs[ownerOutputIndex]!.capacity = ownerCapacity;

  return { tx, totalSwept, cellsSwept: cellsToSweep.length };
}
