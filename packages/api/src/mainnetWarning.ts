import type { Network } from "core";

export interface WarnableLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * TECHNICAL.md §9 / ClaudeCodeInstruction.md global rules: "On mainnet
 * startup, the API logs a prominent warning." Every mainnet startup (API or
 * indexer) logs once, since a process silently reading/writing real CKB
 * instead of testnet is exactly the kind of misconfiguration worth a loud
 * signal.
 */
export function warnIfMainnet(logger: WarnableLogger, network: Network): void {
  if (network !== "mainnet") return;
  logger.warn("[vericell] Starting on MAINNET — this process reads and writes real CKB.");
}
