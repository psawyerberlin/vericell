import { ccc } from "@ckb-ccc/ccc";

/**
 * Cell collector filter restricting capacity-funding collection to cells
 * with empty `outputData` (length 0). Without this, `completeInputsByCapacity`
 * / `completeInputsAtLeastOne` can pick up *any* spendable cell at the payer's
 * lock — including a live VeriCell proof cell from an unrelated project
 * anchored earlier by the same wallet — and silently consume it purely as a
 * funding source. That both corrupts the unrelated project's on-chain state
 * (its cell is now dead with no successor) and would be mis-happending to a
 * "consumed" event by an indexer with no idea why it disappeared. A single
 * wallet anchoring many projects over time makes this a real, not
 * theoretical, risk.
 */
export const PURE_CAPACITY_FILTER: ccc.ClientIndexerSearchKeyFilterLike = {
  outputDataLenRange: [0, 1],
};
