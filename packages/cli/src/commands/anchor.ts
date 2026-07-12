import { readFileSync } from "node:fs";
import { ccc, isFeeCellContentionError, makeClient } from "chain";
import { FEE_EXPLAINER_TEXT, ManifestSchema, type Manifest } from "core";
import { ApiClient, ApiRequestError } from "../lib/apiClient.js";
import { CliError } from "../lib/cliError.js";
import { toManifestDraft } from "../lib/manifestDraft.js";
import { loadSigner } from "../lib/signer.js";

export type AnchorMode = "non-custodial" | "custodial";

export interface AnchorOptions {
  api: string;
  key: string;
  mode: string;
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

interface CustodialAnchorResponse {
  tx_hash: string;
  unid: string;
  note?: string;
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

function requireMode(mode: string): AnchorMode {
  if (mode !== "non-custodial" && mode !== "custodial") {
    throw new CliError('--mode must be "non-custodial" or "custodial"');
  }
  return mode;
}

const MAX_FEE_CONTENTION_ATTEMPTS = 3;

/** Whether `err` looks like a submit failure caused by a fee-collection pool cell another anchor won the race to spend first — see chain's `isFeeCellContentionError`. */
function isRetryableFeeContention(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 502 && isFeeCellContentionError(err);
}

async function anchorNonCustodial(
  api: ApiClient,
  draft: ReturnType<typeof toManifestDraft>,
  opts: AnchorOptions,
): Promise<SubmitResponse> {
  if (!opts.signerKeyFile) {
    throw new CliError("--signer-key-file is required for --mode non-custodial");
  }

  const chainClient = makeClient();
  const signer = await loadSigner(chainClient, opts.signerKeyFile);
  const lock = (await signer.getRecommendedAddressObj()).script;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_FEE_CONTENTION_ATTEMPTS; attempt++) {
    // Re-prepare from scratch on retry: the API picks a fresh pool cell to
    // top up each time (chain's applyServiceFee), so a stale unsigned tx
    // referencing an already-spent pool cell can never be resubmitted as-is.
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
}

async function anchorCustodial(
  api: ApiClient,
  draft: ReturnType<typeof toManifestDraft>,
  manifest: Manifest,
  opts: AnchorOptions,
): Promise<CustodialAnchorResponse> {
  if (!manifest.declared_author) {
    throw new CliError(
      "custodial anchoring requires manifest.declared_author (TECHNICAL.md §7.2-B)",
    );
  }
  const custodialDraft = { ...draft, declared_author: manifest.declared_author };

  if (opts.prev) {
    const version = await api.get<{ unid: string }>(`/versions/${opts.prev}`);
    return api.post<CustodialAnchorResponse>(`/proofs/${version.unid}/versions`, {
      manifest: custodialDraft,
    });
  }
  return api.post<CustodialAnchorResponse>("/proofs", { manifest: custodialDraft });
}

/**
 * `vericell anchor <manifest.json>` — TECHNICAL.md §7.5's automation flow.
 * Non-custodial: prepare -> sign locally with a CCC private-key signer ->
 * submit, the user's key never leaves this process. Custodial: the service
 * wallet at the API signs, so `manifest.declared_author` is required.
 */
export async function runAnchor(manifestPath: string, opts: AnchorOptions): Promise<void> {
  const mode = requireMode(opts.mode);
  const manifest = readManifestFile(manifestPath);
  const draft = toManifestDraft(manifest);
  const api = new ApiClient({ baseUrl: opts.api, apiKey: opts.key });

  let result: SubmitResponse | CustodialAnchorResponse;
  try {
    result =
      mode === "non-custodial"
        ? await anchorNonCustodial(api, draft, opts)
        : await anchorCustodial(api, draft, manifest, opts);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      throw new CliError(`API error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`tx_hash: ${result.tx_hash}`);
    console.log(`unid:    ${result.unid}`);
    if ("note" in result && result.note) console.log(`note:    ${result.note}`);
    // Non-custodial already printed its breakdown before signing (from
    // /proofs/prepare); custodial has no pre-confirm step, so show it here.
    if (mode === "custodial") printCostBreakdown(result.cost, opts);
  }
}
