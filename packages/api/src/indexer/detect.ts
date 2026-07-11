import { ccc } from "@ckb-ccc/ccc";
import { looksLikeVeriCellData } from "chain";
import { decodeManifest, type Manifest } from "core";

export interface Candidate {
  /** Output index within the transaction. */
  index: number;
  manifest: Manifest;
  /** Type ID args if the output carries a Type ID type script, else null (legacy v1 cell, no Type ID). */
  typeIdArgs: ccc.Hex | null;
  lock: ccc.Script;
}

/**
 * Find VeriCell proof-cell outputs in a transaction: a Type ID type script
 * match, or (for cells with no type script) the legacy `{"app":"vericell"`
 * data-prefix heuristic — per TECHNICAL.md §6 / ClaudeCodeInstruction.md
 * Phase 3. Either heuristic is just a cheap pre-filter; the manifest must
 * still decode successfully (zod-validated) for the output to count.
 */
export function detectCandidates(tx: ccc.Transaction, typeIdInfo: ccc.ScriptInfo): Candidate[] {
  const candidates: Candidate[] = [];

  tx.outputs.forEach((output, index) => {
    const data = tx.outputsData[index] ?? "0x";
    if (data === "0x") return;

    const isTypeId =
      !!output.type &&
      output.type.codeHash === typeIdInfo.codeHash &&
      output.type.hashType === typeIdInfo.hashType;
    const isLegacy = !output.type && looksLikeVeriCellData(data);
    if (!isTypeId && !isLegacy) return;

    try {
      const manifest = decodeManifest(ccc.bytesFrom(data));
      candidates.push({
        index,
        manifest,
        typeIdArgs: isTypeId ? (output.type!.args as ccc.Hex) : null,
        lock: output.lock,
      });
    } catch {
      // Heuristic matched but the payload isn't a valid VeriCell manifest — not one of ours.
    }
  });

  return candidates;
}
