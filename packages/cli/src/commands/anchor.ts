import { readFileSync } from "node:fs";
import { ccc, makeClient } from "chain";
import { ManifestSchema, type Manifest } from "core";
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

interface PrepareResponse {
  tx: unknown;
  capacity: string;
  project_sha256: string;
}

interface SubmitResponse {
  tx_hash: string;
  unid: string;
}

interface CustodialAnchorResponse {
  tx_hash: string;
  unid: string;
  note?: string;
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

  const prepared = await api.post<PrepareResponse>("/proofs/prepare", {
    manifest: draft,
    payer: { lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } },
    ...(opts.prev ? { prev_tx_hash: opts.prev } : {}),
  });

  const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
  const signedTx = await signer.signTransaction(unsignedTx);
  const txJson: unknown = JSON.parse(ccc.stringify(signedTx));

  return api.post<SubmitResponse>("/proofs/submit", { tx: txJson });
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
  }
}
