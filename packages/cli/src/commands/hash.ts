import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  ManifestSchema,
  merkleRoot,
  projectHash,
  sha256Hex,
  type Manifest,
  type ManifestFile,
} from "core";
import { walkPaths } from "../lib/walk.js";
import { CliError } from "../lib/cliError.js";

export interface HashOptions {
  out?: string;
  compact?: boolean;
  title?: string;
  source?: string;
  json?: boolean;
}

function sortByPath<T extends { path: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * `vericell hash <dir|files…>` — walks the given paths (§ `lib/walk.ts`),
 * hashes every file, and builds the on-chain manifest with `core`'s own
 * `projectHash`/`merkleRoot` (the exact functions the API and chain use, so
 * the printed `project_sha256` is guaranteed to match what anchoring
 * produces). `--compact` only affects what's written/printed — TECHNICAL.md
 * §3's Merkle-root mode omits `files` from the manifest.
 */
export async function runHash(paths: string[], opts: HashOptions): Promise<void> {
  if (paths.length === 0) {
    throw new CliError("at least one file or directory is required");
  }

  const walked = walkPaths(paths);
  if (walked.length === 0) {
    throw new CliError(`no files found under: ${paths.join(", ")}`);
  }

  const entries = sortByPath(
    await Promise.all(
      walked.map(async (f) => ({
        path: f.relPath,
        hash: await sha256Hex(await readFile(f.absPath)),
      })),
    ),
  );

  const project_sha256 = await projectHash(entries);
  const merkle_root = await merkleRoot(entries);
  const title = opts.title ?? basename(resolve(paths[0]!)) ?? "vericell-project";
  const files: ManifestFile[] | undefined = opts.compact
    ? undefined
    : entries.map((e) => ({ p: e.path, h: e.hash }));

  const manifest: Manifest = ManifestSchema.parse({
    app: "vericell",
    v: 1,
    title,
    created: new Date().toISOString(),
    ...(opts.source ? { source: opts.source } : {}),
    project_sha256,
    merkle_root,
    count: entries.length,
    ...(files ? { files } : {}),
  });

  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...manifest, out: opts.out ?? null }, null, 2));
  } else {
    console.log(`project_sha256: ${project_sha256}`);
    console.log(`merkle_root:    ${merkle_root}`);
    console.log(`files:          ${entries.length}`);
    if (opts.out) console.log(`written:        ${opts.out}`);
  }
}
