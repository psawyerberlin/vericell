import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

export interface WalkedFile {
  /** POSIX-style path recorded in the manifest. */
  relPath: string;
  absPath: string;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function loadGitignore(dir: string): ReturnType<typeof ignore> | null {
  try {
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    return ignore().add(content);
  } catch {
    return null;
  }
}

function walkDir(
  root: string,
  dir: string,
  ig: ReturnType<typeof ignore> | null,
  out: WalkedFile[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    const rel = toPosix(relative(root, abs));
    if (ig?.ignores(rel)) continue;

    if (entry.isDirectory()) {
      walkDir(root, abs, ig, out);
    } else if (entry.isFile()) {
      out.push({ relPath: rel, absPath: abs });
    }
  }
}

/**
 * Walks the given files/directories into a flat file list. A directory
 * argument is walked recursively, relative to itself (so `vericell hash
 * ./dist` records paths like `index.html`, not `dist/index.html`), honoring
 * a `.gitignore` at that directory's own root if present — nested
 * `.gitignore` files are not merged, which covers the common case (a build
 * output directory, a repo checkout) without reimplementing git's full
 * cascading-ignore semantics. `.git` directories are always skipped. A file
 * argument is recorded under its given path as-is.
 */
export function walkPaths(paths: string[]): WalkedFile[] {
  const out: WalkedFile[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      walkDir(p, p, loadGitignore(p), out);
    } else if (st.isFile()) {
      out.push({ relPath: toPosix(p), absPath: p });
    }
  }
  return out;
}
