import { readFile } from "node:fs/promises";
import { sha256Hex } from "core";
import { ApiClient, ApiRequestError } from "../lib/apiClient.js";
import { CliError } from "../lib/cliError.js";

export interface VerifyOptions {
  api: string;
  json?: boolean;
}

interface VerifyResponse {
  found: boolean;
  live: boolean;
  project: { unid: string; title: string } | null;
  version: { tx_hash: string; version_no: number | null; status: string } | null;
  block_time: string | null;
  path: string | null;
}

/**
 * `vericell verify <file>` — hashes locally, asks `GET /verify/{sha256}`.
 * Returns whether the verdict is "found and live" via the return value; the
 * caller sets `process.exitCode` from it (0 = found-and-live, 1 otherwise),
 * per TECHNICAL.md §7.5.
 */
export async function runVerify(filePath: string, opts: VerifyOptions): Promise<boolean> {
  const hash = await sha256Hex(await readFile(filePath));
  const api = new ApiClient({ baseUrl: opts.api });

  let result: VerifyResponse;
  try {
    result = await api.get<VerifyResponse>(`/verify/${hash}`);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      throw new CliError(`API error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify({ sha256: hash, ...result }, null, 2));
  } else if (!result.found) {
    console.log(`NOT FOUND: ${filePath}`);
    console.log(`  sha256: ${hash}`);
    console.log("  No anchored proof contains this SHA-256 hash.");
  } else {
    console.log(`${result.live ? "LIVE" : "SUPERSEDED"}: ${filePath}`);
    console.log(`  sha256:  ${hash}`);
    console.log(`  project: ${result.project?.title ?? "?"} (${result.project?.unid ?? "?"})`);
    console.log(`  version: ${result.version?.tx_hash ?? "?"} (${result.version?.status ?? "?"})`);
    if (result.block_time) console.log(`  anchored: ${result.block_time}`);
    if (result.path) console.log(`  path in manifest: ${result.path}`);
  }

  return result.found && result.live;
}
