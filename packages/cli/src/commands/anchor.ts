import { readFileSync } from "node:fs";
import { ccc, isFeeCellContentionError, makeClient } from "chain";
import { FEE_EXPLAINER_TEXT, ManifestSchema, type Manifest } from "core";
import { ApiClient, ApiRequestError } from "../lib/apiClient.js";
import { CliError } from "../lib/cliError.js";
import { toManifestDraft } from "../lib/manifestDraft.js";
import { loadSigner } from "../lib/signer.js";

export interface AnchorOptions {
  api: string;
  key: string;
  signerKeyFile?: string;
  prev?: string;
  json?: boolean;
}

interface CostBreakdown {
  locked_capacity: string;
  network_fee: string;
  service_fee: string;
  fee_configured: boolean;
}

interface PrepareResponse {
  tx: unknown;
  capacity: string;
  project_sha256: string;
  cost?: CostBreakdown;
}

interface SubmitResponse {
  tx_hash: string;
  unid: string;
  cost?: CostBreakdown;
}

/** shannons, formatted as a CKB amount (trims a whole-CKB fee/capacity to an integer). */
function formatShannons(shannons: string): string {
  const value = BigInt(shannons);
  const ckb = value / 100_000_000n;
  const rem = value % 100_000_000n;
  if (rem === 0n) return `${ckb} CKB`;
  const fraction = rem.toString().padStart(8, "0").replace(/0+$/, "");
  return `${ckb}.${fraction} CKB`;
}

/** Prints the "what this anchor costs" breakdown — skipped in --json mode, where the raw `cost` object speaks for itself. */
function printCostBreakdown(cost: CostBreakdown | undefined, opts: AnchorOptions): void {
  if (!cost || opts.json) return;
  console.log("Cost breakdown:");
  console.log(`  Locked capacity (refundable): ${formatShannons(cost.locked_capacity)}`);
  console.log(`  Network fee: ${cost.network_fee} shannons`);
  console.log(
    cost.fee_configured && BigInt(cost.service_fee) > 0n
      ? `  Service fee: ${formatShannons(cost.service_fee)}`
      : "  Service fee: none",
  );
  console.log(FEE_EXPLAINER_TEXT);
}

function readManifestFile(path: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(
      `could not read manifest "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(`invalid manifest "${path}": ${parsed.error.message}`);
  }
  return parsed.data;
}

const MAX_FEE_CONTENTION_ATTEMPTS = 3;

/** Whether `err` looks like a submit failure caused by a fee-collection pool cell another anchor won the race to spend first — see chain's `isFeeCellContentionError`. */
function isRetryableFeeContention(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 502 && isFeeCellContentionError(err);
}

/**
 * `vericell anchor <manifest.json>` — TECHNICAL.md §7.5's automation flow:
 * prepare -> sign locally with a CCC private-key signer -> submit. The
 * user's key never leaves this process; only the signed transaction ever
 * reaches the API.
 */
export async function runAnchor(manifestPath: string, opts: AnchorOptions): Promise<void> {
  if (!opts.signerKeyFile) {
    throw new CliError("--signer-key-file is required");
  }

  const manifest = readManifestFile(manifestPath);
  const draft = toManifestDraft(manifest);
  const api = new ApiClient({ baseUrl: opts.api, apiKey: opts.key });

  const chainClient = makeClient();
  const signer = await loadSigner(chainClient, opts.signerKeyFile);
  const lock = (await signer.getRecommendedAddressObj()).script;

  let result: SubmitResponse;
  try {
    let lastErr: unknown;
    result = await (async () => {
      for (let attempt = 0; attempt < MAX_FEE_CONTENTION_ATTEMPTS; attempt++) {
        // Re-prepare from scratch on retry: the API picks a fresh pool cell
        // to top up each time (chain's applyServiceFee), so a stale
        // unsigned tx referencing an already-spent pool cell can never be
        // resubmitted as-is.
        const prepared = await api.post<PrepareResponse>("/proofs/prepare", {
          manifest: draft,
          payer: { lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } },
          ...(opts.prev ? { prev_tx_hash: opts.prev } : {}),
        });
        if (attempt === 0) printCostBreakdown(prepared.cost, opts);

        const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
        const signedTx = await signer.signTransaction(unsignedTx);
        const txJson: unknown = JSON.parse(ccc.stringify(signedTx));

        try {
          return await api.post<SubmitResponse>("/proofs/submit", { tx: txJson });
        } catch (err) {
          if (!isRetryableFeeContention(err)) throw err;
          lastErr = err;
        }
      }
      throw lastErr;
    })();
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
  }
}
