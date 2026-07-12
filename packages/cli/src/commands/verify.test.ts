import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "core";
import { CliError } from "../lib/cliError.js";
import { runVerify } from "./verify.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("runVerify", () => {
  let dir: string;
  let filePath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vericell-verify-cmd-test-"));
    filePath = join(dir, "release.zip");
    writeFileSync(filePath, "release contents");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("hashes the file and queries /verify/{sha256}, returning true for found+live", async () => {
    const hash = await sha256Hex(new TextEncoder().encode("release contents"));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      expect(url).toBe(`http://api.test/api/v1/verify/${hash}`);
      return Promise.resolve(
        jsonResponse(200, {
          found: true,
          live: true,
          project: { unid: "0xabc", title: "My Project" },
          version: { tx_hash: "0xdef", version_no: 1, status: "committed" },
          block_time: "2026-01-01T00:00:00.000Z",
          path: "a.txt",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await runVerify(filePath, { api: "http://api.test/api/v1" });
    expect(ok).toBe(true);
    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/LIVE/);
  });

  it("returns false when found but superseded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        found: true,
        live: false,
        project: { unid: "0xabc", title: "My Project" },
        version: { tx_hash: "0xdef", version_no: 1, status: "consumed" },
        block_time: null,
        path: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await runVerify(filePath, { api: "http://api.test/api/v1" });
    expect(ok).toBe(false);
    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/SUPERSEDED/);
  });

  it("returns false when not found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        found: false,
        live: false,
        project: null,
        version: null,
        block_time: null,
        path: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await runVerify(filePath, { api: "http://api.test/api/v1" });
    expect(ok).toBe(false);
    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/NOT FOUND/);
  });

  it("--json prints the sha256 alongside the API response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        found: false,
        live: false,
        project: null,
        version: null,
        block_time: null,
        path: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runVerify(filePath, { api: "http://api.test/api/v1", json: true });
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      sha256: string;
      found: boolean;
    };
    expect(printed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(printed.found).toBe(false);
  });

  it("wraps an API error as a CliError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { title: "Internal Server Error" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runVerify(filePath, { api: "http://api.test/api/v1" })).rejects.toThrow(CliError);
  });
});
