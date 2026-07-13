import { ccc, makeClient } from "chain";
import { ApiClient, ApiRequestError } from "../lib/apiClient.js";
import { CliError } from "../lib/cliError.js";
import { loadSigner } from "../lib/signer.js";

export interface WithdrawOptions {
  api: string;
  key: string;
  signerKeyFile?: string;
  json?: boolean;
}

interface ProjectDetail {
  unid: string;
  active: boolean;
  live_tx_hash: string | null;
  live_index: number;
  ckb_address: string;
}

interface PrepareWithdrawResponse {
  tx: unknown;
  refund_capacity: string;
}

interface SubmitWithdrawResponse {
  tx_hash: string;
  unid: string;
  refund_capacity: string;
}

/**
 * `vericell withdraw <unid>` — resolves the project's live tx hash via the
 * public API, then goes through the same prepare -> sign locally -> submit
 * flow as `anchor` (`/proofs/prepare` with `withdraw_tx_hash`). The signer
 * must own the live cell's lock; the API never holds a key.
 */
export async function runWithdraw(unid: string, opts: WithdrawOptions): Promise<void> {
  if (!opts.signerKeyFile) {
    throw new CliError("--signer-key-file is required");
  }

  const publicApi = new ApiClient({ baseUrl: opts.api });
  let project: ProjectDetail;
  try {
    project = await publicApi.get<ProjectDetail>(`/projects/${unid}`);
  } catch (err) {
    if (err instanceof ApiRequestError)
      throw new CliError(`API error (${err.status}): ${err.message}`);
    throw err;
  }
  if (!project.active || !project.live_tx_hash) {
    throw new CliError(`project "${unid}" has no live proof to withdraw`);
  }

  const chainClient = makeClient();
  const signer = await loadSigner(chainClient, opts.signerKeyFile);
  const lock = (await signer.getRecommendedAddressObj()).script;
  const ownerAddress = ccc.Address.fromScript(lock, chainClient).toString();
  if (ownerAddress !== project.ckb_address) {
    throw new CliError(
      `signer does not own project "${unid}" (owner: ${project.ckb_address}, signer: ${ownerAddress})`,
    );
  }

  const api = new ApiClient({ baseUrl: opts.api, apiKey: opts.key });

  let result: SubmitWithdrawResponse;
  try {
    const prepared = await api.post<PrepareWithdrawResponse>("/proofs/prepare", {
      withdraw_tx_hash: project.live_tx_hash,
    });
    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await signer.signTransaction(unsignedTx);
    const txJson: unknown = JSON.parse(ccc.stringify(signedTx));
    result = await api.post<SubmitWithdrawResponse>("/proofs/submit", { tx: txJson });
  } catch (err) {
    if (err instanceof ApiRequestError)
      throw new CliError(`API error (${err.status}): ${err.message}`);
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`tx_hash: ${result.tx_hash}`);
    console.log(`unid:    ${result.unid}`);
    console.log(`refund:  ${result.refund_capacity} shannons`);
  }
}
