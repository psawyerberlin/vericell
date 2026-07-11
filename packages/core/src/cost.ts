import { encodeManifest, type Manifest } from "./manifest.js";

const CELL_OVERHEAD_CKB = 61;

export interface CellCostEstimate {
  /** Capacity in CKB for the manifest as given (files included, if present). */
  full: number;
  /** Capacity in CKB for the manifest with `files` omitted (compact mode). */
  compact: number;
}

/**
 * Cell capacity estimate: 1 CKB = 1 byte of cell data, plus the 61 CKB
 * minimum cell overhead (TECHNICAL.md §3).
 */
export function estimateCellCost(manifest: Manifest): CellCostEstimate {
  const fullBytes = encodeManifest(manifest).length;
  const compactManifest: Manifest = { ...manifest };
  delete compactManifest.files;
  const compactBytes = encodeManifest(compactManifest).length;
  return {
    full: fullBytes + CELL_OVERHEAD_CKB,
    compact: compactBytes + CELL_OVERHEAD_CKB,
  };
}
