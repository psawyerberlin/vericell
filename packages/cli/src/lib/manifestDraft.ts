import type { Manifest, ManifestFile } from "core";
import { CliError } from "./cliError.js";

/** Shape the API's `ManifestDraftSchema` (`packages/api/src/server/writeSchemas.ts`) expects. */
export interface ManifestDraftPayload {
  title: string;
  created?: string;
  source?: string;
  files: ManifestFile[];
}

/**
 * A manifest.json produced by `vericell hash` is a full on-chain manifest
 * (TECHNICAL.md §3); anchoring re-sends it as a *draft* so the server can
 * independently recompute `project_sha256`/`merkle_root`/`count` rather than
 * trust the client's numbers. `files` must be present — a manifest written
 * with `hash --compact` has none, and can't be recovered here (the CLI only
 * has the manifest file, not the original directory).
 */
export function toManifestDraft(manifest: Manifest): ManifestDraftPayload {
  if (!manifest.files || manifest.files.length === 0) {
    throw new CliError(
      "manifest has no files list (it looks like it was produced with `vericell hash --compact`); " +
        "re-run `vericell hash` without --compact to anchor",
    );
  }
  return {
    title: manifest.title,
    created: manifest.created,
    ...(manifest.source !== undefined ? { source: manifest.source } : {}),
    files: manifest.files,
  };
}
