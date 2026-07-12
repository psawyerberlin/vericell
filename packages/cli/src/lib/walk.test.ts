import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkPaths } from "./walk.js";

describe("walkPaths", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vericell-walk-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("walks a directory recursively, recording POSIX-style relative paths", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "sub", "b.txt"), "b");

    const files = walkPaths([dir]);
    expect(files.map((f) => f.relPath).sort()).toEqual(["a.txt", "sub/b.txt"]);
  });

  it("skips .git directories unconditionally", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(dir, "a.txt"), "a");

    const files = walkPaths([dir]);
    expect(files.map((f) => f.relPath)).toEqual(["a.txt"]);
  });

  it("respects a .gitignore at the walked directory's root", () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\nbuild/\n");
    writeFileSync(join(dir, "ignored.txt"), "should be excluded");
    writeFileSync(join(dir, "kept.txt"), "should be included");
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "output.js"), "excluded via directory pattern");

    const files = walkPaths([dir]);
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual([".gitignore", "kept.txt"]);
  });

  it("works without a .gitignore present at all", () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const files = walkPaths([dir]);
    expect(files.map((f) => f.relPath)).toEqual(["a.txt"]);
  });

  it("records a file argument under its given path as-is", () => {
    const filePath = join(dir, "standalone.txt");
    writeFileSync(filePath, "content");

    const files = walkPaths([filePath]);
    expect(files).toHaveLength(1);
    expect(files[0]!.absPath).toBe(filePath);
  });

  it("merges multiple path arguments (dirs and files together)", () => {
    mkdirSync(join(dir, "sub1"), { recursive: true });
    writeFileSync(join(dir, "sub1", "x.txt"), "x");
    const standalone = join(dir, "standalone.txt");
    writeFileSync(standalone, "y");

    const files = walkPaths([join(dir, "sub1"), standalone]);
    // A directory arg's own files are recorded relative to itself ("x.txt",
    // not "sub1/x.txt"); a file arg is recorded under its given path as-is
    // — see walk.ts's doc comment for both.
    expect(files.map((f) => f.relPath).sort()).toEqual([standalone, "x.txt"].sort());
  });
});
