import { makeClient, fetchProof as chainFetchProof, ccc, type ProofResult } from "chain";

export type FetchProofFn = (txHash: string, index?: number) => Promise<ProofResult>;
export type GetTipFn = () => Promise<bigint>;

let cachedClient: ccc.Client | null = null;

/** Lazily built so importing/testing this module never opens a network connection by itself. */
function getClient(): ccc.Client {
  cachedClient ??= makeClient();
  return cachedClient;
}

/** Default chain lookup used outside tests: a real RPC call via `chain`'s `fetchProof`. */
export const defaultFetchProof: FetchProofFn = (txHash, index = 0) =>
  chainFetchProof(getClient(), txHash, index);

export const defaultGetTip: GetTipFn = () => getClient().getTip();
