import { makeClient, ccc } from "chain";
import { NETWORK, type Network } from "core";

export type GetChainClientFn = () => ccc.Client;
export type GetCustodialSignerFn = () => Promise<ccc.SignerCkbPrivateKey>;

const cachedClients = new Map<Network, ccc.Client>();

/**
 * A raw `ccc.Client`, lazily built and cached *per network* so importing/
 * testing this module never opens a network connection by itself — same
 * rationale as `chainLookup.ts`'s `getClient()`, and the same per-network
 * keying (Phase 10a: one API process now serves testnet and mainnet at
 * once, so a single shared client would leak across them).
 * `/proofs/prepare|submit` and the custodial routes need the real client
 * (not just `fetchProof`/`getTip`), since they call into `chain`'s tx
 * builders and `sendTransaction`.
 */
function getOrMakeClient(network: Network): ccc.Client {
  let client = cachedClients.get(network);
  if (!client) {
    client = makeClient(network);
    cachedClients.set(network, client);
  }
  return client;
}

export function makeDefaultGetChainClient(network: Network = NETWORK): GetChainClientFn {
  return () => getOrMakeClient(network);
}

export const defaultGetChainClient: GetChainClientFn = makeDefaultGetChainClient();

function truthyEnvFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * Whether custodial mode should be active for this process. Reads
 * `CUSTODIAL_ENABLED`; on mainnet, additionally refuses unless
 * `MAINNET_CONFIRM=1` is also set (TECHNICAL.md §9 / ClaudeCodeInstruction.md
 * global rules), logging a prominent warning instead of silently ignoring
 * the operator's request.
 */
export function resolveCustodialEnabled(
  network: Network = NETWORK,
  env: Record<string, string | undefined> | undefined = globalThis.process?.env,
): boolean {
  const requested = truthyEnvFlag(env?.CUSTODIAL_ENABLED);
  if (!requested) return false;
  if (network === "mainnet" && env?.MAINNET_CONFIRM !== "1") {
    // Fires before/without a configured logger — this is the earliest
    // point in startup that knows custodial mode was requested but denied.
    console.warn(
      "[vericell] CUSTODIAL_ENABLED is set but refusing to enable custodial mode on " +
        "mainnet without MAINNET_CONFIRM=1 — see TECHNICAL.md §9.",
    );
    return false;
  }
  return true;
}

const cachedSigners = new Map<Network, Promise<ccc.SignerCkbPrivateKey>>();

/**
 * Lazily built + connected service-wallet signer for custodial mode, cached
 * per network (Phase 10a: testnet and mainnet each get their own connected
 * signer instance, sharing the one `SERVICE_PRIVATE_KEY` — the same keypair
 * is valid on both chains, only its address encoding differs). Throws (on
 * first use, not at import time) if `SERVICE_PRIVATE_KEY` isn't set — routes
 * only call this once they've already confirmed custodial mode is enabled
 * for that network.
 */
export function makeDefaultGetCustodialSigner(network: Network = NETWORK): GetCustodialSignerFn {
  return () => {
    let pending = cachedSigners.get(network);
    if (!pending) {
      pending = (async () => {
        const privateKey = globalThis.process?.env?.SERVICE_PRIVATE_KEY;
        if (!privateKey) {
          throw new Error("CUSTODIAL_ENABLED requires SERVICE_PRIVATE_KEY to be set");
        }
        const signer = new ccc.SignerCkbPrivateKey(getOrMakeClient(network), privateKey);
        await signer.connect();
        return signer;
      })();
      cachedSigners.set(network, pending);
    }
    return pending;
  };
}

export const defaultGetCustodialSigner: GetCustodialSignerFn = makeDefaultGetCustodialSigner();
