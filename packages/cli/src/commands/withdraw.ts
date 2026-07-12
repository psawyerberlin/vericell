import { buildWithdrawTx, ccc, makeClient } from "chain";
import { ApiClient, ApiRequestError } from "../lib/apiClient.js";
import { CliError } from "../lib/cliError.js";
import { loadSigner } from "../lib/signer.js";

export type WithdrawMode = "non-custodial" | "custodial";

export interface WithdrawOptions {
  api: string;
  key: string;
  mode?: string;
  signerKeyFile?: string;
  json?: boolean;
}

interface WithdrawResult {
  tx_hash: string;
  unid: string;
  refund_capacity?: string;
  note?: string;
}

interface ProjectDetail {
  unid: string;
  active: boolean;
  live_tx_hash: string | null;
  live_index: number;
  ckb_address: string;
}

function requireMode(mode: string | undefined): WithdrawMode {
  const resolved = mode ?? "custodial";
  if (resolved !== "non-custodial" && resolved !== "custodial") {
    throw new CliError('--mode must be "non-custodial" or "custodial"');
  }
  return resolved;
}

/**
 * Non-custodial withdraw has no `/proofs/{unid}` DELETE counterpart on the
 * API (TECHNICAL.md §7.2-B's withdraw route is custodial-only, signed by
 * the service wallet) — the caller signs, so this builds and broadcasts the
 * withdraw transaction directly against the chain, the same way `anchor
 * --mode non-custodial` never sends a private key to the server. The
 * project's live cell location comes from the public `GET /projects/{unid}`.
 */
async function withdrawNonCustodial(unid: string, opts: WithdrawOptions): Promise<WithdrawResult> {
  if (!opts.signerKeyFile) {
    throw new CliError("--signer-key-file is required for --mode non-custodial");
  }

  const publicApi = new ApiClient({ baseUrl: opts.api });
  let project: ProjectDetail;
  try {
    project = await publicApi.get<ProjectDetail>(`/projects/${unid}`);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      throw new CliError(`API error (${err.status}): ${err.message}`);
    }
    throw err;
  }
  if (!project.active || !project.live_tx_hash) {
    throw new CliError(`project "${unid}" has no live proof to withdraw`);
  }

  const client = makeClient();
  const signer = await loadSigner(client, opts.signerKeyFile);
  const lock = (await signer.getRecommendedAddressObj()).script;
  const ownerAddress = ccc.Address.fromScript(lock, client).toString();
  if (ownerAddress !== project.ckb_address) {
    throw new CliError(
      `signer does not own project "${unid}" (owner: ${project.ckb_address}, signer: ${ownerAddress})`,
    );
  }

  const liveCell = await client.getCell({
    txHash: project.live_tx_hash,
    index: project.live_index,
  });
  if (!liveCell) {
    throw new CliError(`live cell for "${unid}" not found on chain`);
  }

  const tx = await buildWithdrawTx({ client, lock, outPoint: liveCell.outPoint });
  const txHash = await signer.sendTransaction(tx);

  return { tx_hash: txHash, unid, refund_capacity: tx.outputs[0]!.capacity.toString() };
}

/** `vericell withdraw <unid>` — custodial: `DELETE /proofs/{unid}`; non-custodial: see above. */
export async function runWithdraw(unid: string, opts: WithdrawOptions): Promise<void> {
  const mode = requireMode(opts.mode);

  let result: WithdrawResult;
  if (mode === "custodial") {
    const api = new ApiClient({ baseUrl: opts.api, apiKey: opts.key });
    try {
      result = await api.delete<WithdrawResult>(`/proofs/${unid}`);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        throw new CliError(`API error (${err.status}): ${err.message}`);
      }
      throw err;
    }
  } else {
    result = await withdrawNonCustodial(unid, opts);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`tx_hash: ${result.tx_hash}`);
    console.log(`unid:    ${result.unid}`);
    if (result.refund_capacity) console.log(`refund:  ${result.refund_capacity} shannons`);
    if (result.note) console.log(`note:    ${result.note}`);
  }
}
