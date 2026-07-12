import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../lib/cliError.js";
import { runStatus } from "./status.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const DETAIL = {
  unid: "0xabc",
  title: "My Project",
  active: true,
  ckb_address: "ckt1qzda0...",
  live_tx_hash: "0xdef",
  versions: [
    {
      tx_hash: "0xdef",
      version_no: 1,
      status: "committed",
      block_time: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("runStatus", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("prints a human summary including the version list", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, DETAIL)));

    await runStatus("0xabc", { api: "http://api.test/api/v1" });
    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toMatch(/My Project/);
    expect(printed).toMatch(/0xdef/);
  });

  it("--json prints the raw project detail", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, DETAIL)));

    await runStatus("0xabc", { api: "http://api.test/api/v1", json: true });
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as { unid: string };
    expect(printed.unid).toBe("0xabc");
  });

  it("wraps a 404 as a CliError", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { title: "Not Found", detail: "No project" })),
    );

    await expect(runStatus("does-not-exist", { api: "http://api.test/api/v1" })).rejects.toThrow(
      CliError,
    );
  });
});
