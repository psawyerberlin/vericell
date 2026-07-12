import type { Network } from "core";

export interface WarnableLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * TECHNICAL.md §9 / ClaudeCodeInstruction.md global rules: "On mainnet
 * startup, the API logs a prominent warning and refuses to start custodial
 * mode unless MAINNET_CONFIRM=1 is also set." The custodial-mode refusal is
 * `server/chainClient.ts`'s `resolveCustodialEnabled` — this is the other,
 * unconditional half: every mainnet startup (API or indexer, custodial or
 * not) logs once, since a process silently reading/writing real CKB instead
 * of testnet is exactly the kind of misconfiguration worth a loud signal.
 */
export function warnIfMainnet(logger: WarnableLogger, network: Network): void {
  if (network !== "mainnet") return;
  logger.warn(
    "[vericell] Starting on MAINNET — this process reads and writes real CKB. " +
      "Custodial mode additionally refuses to start without MAINNET_CONFIRM=1. See TECHNICAL.md §9.",
  );
}
