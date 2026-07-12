import { ApiClient, ApiRequestError } from "../lib/apiClient.js";
import { CliError } from "../lib/cliError.js";

export interface StatusOptions {
  api: string;
  json?: boolean;
}

interface VersionRecord {
  tx_hash: string;
  version_no: number | null;
  status: string;
  block_time: string | null;
}

interface ProjectDetail {
  unid: string;
  title: string;
  active: boolean;
  ckb_address: string;
  live_tx_hash: string | null;
  versions: VersionRecord[];
}

/** `vericell status <unid>` — `GET /projects/{unid}`. */
export async function runStatus(unid: string, opts: StatusOptions): Promise<void> {
  const api = new ApiClient({ baseUrl: opts.api });

  let detail: ProjectDetail;
  try {
    detail = await api.get<ProjectDetail>(`/projects/${unid}`);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      throw new CliError(`API error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  console.log(`title:   ${detail.title}`);
  console.log(`unid:    ${detail.unid}`);
  console.log(`active:  ${detail.active}`);
  console.log(`owner:   ${detail.ckb_address}`);
  console.log(`live tx: ${detail.live_tx_hash ?? "(none — withdrawn)"}`);
  console.log("versions:");
  for (const v of detail.versions) {
    console.log(
      `  v${v.version_no ?? "?"}  ${v.tx_hash}  ${v.status}  ${v.block_time ?? "(pending)"}`,
    );
  }
}
