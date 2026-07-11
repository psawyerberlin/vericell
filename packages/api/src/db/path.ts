import { join } from "node:path";
import { NETWORK, type Network } from "core";

/**
 * The DB file is network-scoped (`vericell.<network>.sqlite`) so a testnet
 * index can never be mistaken for mainnet data (global rule in
 * ClaudeCodeInstruction.md). `DB_PATH` is an explicit full-path override —
 * used by deployments (Phase 10's `.env.example`) and by tests that want an
 * isolated file or `:memory:`; it is trusted to already be network-scoped by
 * whoever set it.
 */
export function resolveDbPath(network: Network = NETWORK): string {
  const override = globalThis.process?.env?.DB_PATH;
  if (override) return override;
  const dir = globalThis.process?.env?.DB_DIR ?? "data";
  return join(dir, `vericell.${network}.sqlite`);
}
