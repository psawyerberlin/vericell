import type { Network } from "./network.js";

const SHANNONS_PER_CKB = 100_000_000n;

/** Below this locked capacity, no service fee is charged at all. */
export const FEE_WAIVER_CKB = 300n;
export const FEE_WAIVER_SHANNONS = FEE_WAIVER_CKB * SHANNONS_PER_CKB;

/** Service fee rate: 1% of the new proof cell's locked capacity. */
const FEE_RATE_NUM = 1n;
const FEE_RATE_DEN = 100n;

/**
 * The service fee due for a proof cell locking `capacityShannons`: 1% of
 * capacity, floored to the nearest shannon, waived entirely below
 * {@link FEE_WAIVER_CKB} (300 CKB) — so the vast majority of ordinary
 * anchors (compact-mode manifests, small projects) pay nothing.
 */
export function computeFee(capacityShannons: bigint): bigint {
  if (capacityShannons < FEE_WAIVER_SHANNONS) return 0n;
  return (capacityShannons * FEE_RATE_NUM) / FEE_RATE_DEN;
}

function feeAddressEnvVar(network: Network): string {
  return `VERICELL_FEE_ADDRESS_${network.toUpperCase()}`;
}

/**
 * Reads `VITE_VERICELL_FEE_ADDRESS_<NETWORK>` from `import.meta.env`, the
 * web build's baked-in form. Vite only statically replaces (and thus
 * inlines/tree-shakes) `import.meta.env` accessed as a single, un-aliased
 * literal chain (`import.meta.env.VITE_X`) in a production build — a
 * *computed* key (`import.meta.env[someExpression]`), or assigning
 * `import.meta`/`import.meta.env` to a variable first and accessing the key
 * afterward, both leave `import.meta.env` as the real (unpolyfilled, so
 * `undefined`) runtime value instead of the build-time string. Confirmed
 * empirically against a real `vite build` — see docs/DECISIONS.md and
 * `network.ts`'s `resolveNetwork`, which hit the exact same failure mode.
 * Since `Network` only ever has three values, each is spelled out as its
 * own direct access rather than building the key from `network` at runtime.
 */
function readViteFeeAddress(network: Network): string | undefined {
  switch (network) {
    case "testnet":
      return (import.meta as unknown as { env?: Record<string, string | undefined> }).env
        ?.VITE_VERICELL_FEE_ADDRESS_TESTNET;
    case "mainnet":
      return (import.meta as unknown as { env?: Record<string, string | undefined> }).env
        ?.VITE_VERICELL_FEE_ADDRESS_MAINNET;
    case "devnet":
      return (import.meta as unknown as { env?: Record<string, string | undefined> }).env
        ?.VITE_VERICELL_FEE_ADDRESS_DEVNET;
  }
}

/**
 * The service-fee recipient address configured for `network`, or `undefined`
 * if none is set — the single source of truth for whether fee logic runs at
 * all on that network. No address is ever hardcoded in this repo: every
 * caller (chain, api, cli, web) must go through this function, and a network
 * with no `VERICELL_FEE_ADDRESS_<NETWORK>` / `VITE_VERICELL_FEE_ADDRESS_<NETWORK>`
 * set (the default for devnet, and for testnet/mainnet until an operator
 * configures one) has fee collection fully disabled — no ACP lookups, no fee
 * leg on anchor transactions, no rejection at submit time.
 */
export function getFeeAddress(network: Network): string | undefined {
  const raw = globalThis.process?.env?.[feeAddressEnvVar(network)] || readViteFeeAddress(network);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether the service fee is active for `network` at all (i.e. an address is configured). */
export function isFeeConfigured(network: Network): boolean {
  return getFeeAddress(network) !== undefined;
}

export interface CostBreakdown {
  /** The new proof cell's locked capacity, in shannons — refundable later by withdrawing or superseding it. */
  lockedCapacityShannons: bigint;
  /** Service fee in shannons — 0n whenever waived (below 300 CKB) or not configured for this network. */
  serviceFeeShannons: bigint;
  /** Whether `network` has a fee recipient configured at all. */
  feeConfigured: boolean;
}

/**
 * The full "what this anchor costs" breakdown for a proof cell locking
 * `capacityShannons` on `network` — shared by the CLI's anchor command and
 * the web app's pre-wallet-confirm summary so both present identical
 * numbers. Does not include the CKB network transaction fee (a few hundred
 * shannons, sized from the actual transaction bytes) — that's computed
 * separately once the transaction is built (`tx.getFee(client)`).
 */
export function costBreakdown(capacityShannons: bigint, network: Network): CostBreakdown {
  const feeConfigured = isFeeConfigured(network);
  return {
    lockedCapacityShannons: capacityShannons,
    serviceFeeShannons: feeConfigured ? computeFee(capacityShannons) : 0n,
    feeConfigured,
  };
}

/**
 * Published explainer of the service-fee model — shown verbatim wherever a
 * cost breakdown is presented (CLI anchor output, web pre-confirm summary),
 * so the same wording backs every anchor regardless of client.
 */
export const FEE_EXPLAINER_TEXT =
  "VeriCell anchors are free of any service fee below 300 CKB of locked capacity. " +
  "At or above that, a 1% service fee applies on top of the locked capacity. The locked " +
  "capacity itself is never spent — it stays refundable to you later, by withdrawing the " +
  "proof cell or superseding it with a new version. Only the service fee (when one applies) " +
  "leaves your wallet for good.";
