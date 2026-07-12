import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManifestSchema } from "core";
import { CliError } from "../lib/cliError.js";
import { runHash } from "./hash.js";

describe("runHash", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vericell-hash-cmd-test-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it("throws a CliError when given no paths", async () => {
    await expect(runHash([], {})).rejects.toThrow(CliError);
  });

  it("throws a CliError when no files are found", async () => {
    const emptyDir = join(dir, "empty");
    mkdirSync(emptyDir);
    await expect(runHash([emptyDir], {})).rejects.toThrow(/no files found/);
  });

  it("produces a valid, deterministic manifest across two runs", async () => {
    // The fixture files live in their own subdirectory so the manifest.json
    // output (written into `dir`) never becomes an extra input on rerun.
    const fixtureDir = join(dir, "fixture");
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, "a.txt"), "hello\n");
    writeFileSync(join(fixtureDir, "b.txt"), "world\n");

    const outPath = join(dir, "manifest.json");
    await runHash([fixtureDir], { out: outPath });

    const written = JSON.parse(readFileSync(outPath, "utf8")) as unknown;
    const parsed = ManifestSchema.parse(written);
    expect(parsed.count).toBe(2);
    expect(parsed.files?.map((f) => f.p).sort()).toEqual(["a.txt", "b.txt"]);

    // Re-run: same content, same project_sha256.
    const outPath2 = join(dir, "manifest2.json");
    await runHash([fixtureDir], { out: outPath2 });
    const written2 = ManifestSchema.parse(JSON.parse(readFileSync(outPath2, "utf8")));
    expect(written2.project_sha256).toBe(parsed.project_sha256);
  });

  it("--compact omits the files list from the written manifest", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const outPath = join(dir, "manifest.json");
    await runHash([dir], { out: outPath, compact: true });

    const written = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>;
    expect(written).not.toHaveProperty("files");
    expect(typeof written.project_sha256).toBe("string");
  });

  it("--title and --source flow through into the manifest", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const outPath = join(dir, "manifest.json");
    await runHash([dir], { out: outPath, title: "My Project", source: "https://example.com/x" });

    const written = JSON.parse(readFileSync(outPath, "utf8")) as { title: string; source: string };
    expect(written.title).toBe("My Project");
    expect(written.source).toBe("https://example.com/x");
  });

  it("defaults the title to the first path's basename when --title is omitted", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const outPath = join(dir, "manifest.json");
    await runHash([dir], { out: outPath });

    const written = JSON.parse(readFileSync(outPath, "utf8")) as { title: string };
    expect(written.title).toBe(dir.split("/").pop());
  });

  it("without --out, prints but does not write a file", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const outPath = join(dir, "manifest.json");
    await runHash([dir], {});
    expect(existsSync(outPath)).toBe(false);
    expect(logSpy).toHaveBeenCalled();
  });

  it("--json prints the full manifest as JSON", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    await runHash([dir], { json: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const parsed = JSON.parse(printed) as { project_sha256: string; out: string | null };
    expect(parsed.project_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.out).toBeNull();
  });
});
