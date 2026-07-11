import { sha256Hex } from "./hash.js";

export interface FileEntry {
  path: string;
  hash: string;
}

/**
 * project_sha256 per TECHNICAL.md §3: SHA-256 over the canonical string
 * built by sorting entries by path and concatenating `path\nhash\n` for each.
 * This exact definition is normative and lives only here.
 */
export async function projectHash(entries: FileEntry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let canonical = "";
  for (const entry of sorted) {
    canonical += `${entry.path}\n${entry.hash}\n`;
  }
  return sha256Hex(new TextEncoder().encode(canonical));
}
