import { makeClient, ccc } from "chain";
import { NETWORK, type Network } from "core";

export type GetChainClientFn = () => ccc.Client;

const cachedClients = new Map<Network, ccc.Client>();

/**
 * A raw `ccc.Client`, lazily built and cached *per network* so importing/
 * testing this module never opens a network connection by itself — same
 * rationale as `chainLookup.ts`'s `getClient()`, and the same per-network
 * keying (Phase 10a: one API process now serves testnet and mainnet at
 * once, so a single shared client would leak across them).
 * `/proofs/prepare|submit` need the real client (not just `fetchProof`/
 * `getTip`), since they call into `chain`'s tx builders and `sendTransaction`.
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
