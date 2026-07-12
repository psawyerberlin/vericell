import { makeClient, fetchProof as chainFetchProof, ccc, type ProofResult } from "chain";
import { NETWORK, type Network } from "core";

export type FetchProofFn = (txHash: string, index?: number) => Promise<ProofResult>;
export type GetTipFn = () => Promise<bigint>;

const cachedClients = new Map<Network, ccc.Client>();

/**
 * Lazily built and cached *per network*, so importing/testing this module
 * never opens a network connection by itself. Phase 10a: a single API
 * process can now serve both testnet and mainnet at once, so caching a lone
 * client (as before) would silently hand mainnet's requests a testnet
 * client or vice versa — every lookup here is keyed by network instead.
 */
function getClient(network: Network): ccc.Client {
  let client = cachedClients.get(network);
  if (!client) {
    client = makeClient(network);
    cachedClients.set(network, client);
  }
  return client;
}

/** Default chain lookup used outside tests: a real RPC call via `chain`'s `fetchProof`, scoped to `network`. */
export function makeDefaultFetchProof(network: Network = NETWORK): FetchProofFn {
  return (txHash, index = 0) => chainFetchProof(getClient(network), txHash, index);
}

export function makeDefaultGetTip(network: Network = NETWORK): GetTipFn {
  return () => getClient(network).getTip();
}

/** Back-compat single-network conveniences, bound to the process-default network. */
export const defaultFetchProof: FetchProofFn = makeDefaultFetchProof();
export const defaultGetTip: GetTipFn = makeDefaultGetTip();
