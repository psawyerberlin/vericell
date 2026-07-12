import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ccc, FakeClient } from "chain";
import { CliError } from "../lib/cliError.js";
import { runWithdraw } from "./withdraw.js";

// Mirrors anchor.test.ts's approach: `runWithdraw`'s non-custodial branch
// calls `makeClient()` itself, intercepted here to resolve to a shared
// FakeClient instead of a real network connection.
let fakeClient: FakeClient | undefined;
vi.mock("chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chain")>();
  return { ...actual, makeClient: () => fakeClient };
});

const OWNER_PRIVATE_KEY = "0x" + "cd".repeat(32);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("runWithdraw", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vericell-withdraw-cmd-test-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    fakeClient = undefined;
  });

  describe("custodial (default mode)", () => {
    it("DELETEs /proofs/{unid} and prints the refund", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation((url: string, init: NonNullable<Parameters<typeof fetch>[1]>) => {
          expect(url).toBe("http://api.test/api/v1/proofs/0xunid");
          expect(init.method).toBe("DELETE");
          expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
          return Promise.resolve(
            jsonResponse(202, {
              tx_hash: "0xabc",
              unid: "0xunid",
              refund_capacity: "1000",
              note: "custodial trade-off",
            }),
          );
        });
      vi.stubGlobal("fetch", fetchMock);

      await runWithdraw("0xunid", { api: "http://api.test/api/v1", key: "test-key" });
      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/0xabc/);
      expect(printed).toMatch(/1000/);
    });

    it("wraps an API error as a CliError", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(jsonResponse(404, { title: "Not Found", detail: "No live project" })),
      );

      await expect(
        runWithdraw("does-not-exist", { api: "http://api.test/api/v1", key: "test-key" }),
      ).rejects.toThrow(/No live project/);
    });
  });

  describe("non-custodial", () => {
    it("requires --signer-key-file", async () => {
      await expect(
        runWithdraw("0xunid", {
          api: "http://api.test/api/v1",
          key: "test-key",
          mode: "non-custodial",
        }),
      ).rejects.toThrow(/--signer-key-file/);
    });

    it("errors when the project has no live proof", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(200, { active: false, live_tx_hash: null })),
      );
      const keyFile = join(dir, "signer.key");
      writeFileSync(keyFile, OWNER_PRIVATE_KEY, "utf8");

      await expect(
        runWithdraw("0xunid", {
          api: "http://api.test/api/v1",
          key: "test-key",
          mode: "non-custodial",
          signerKeyFile: keyFile,
        }),
      ).rejects.toThrow(/no live proof/);
    });

    it("errors when the signer doesn't own the project", async () => {
      fakeClient = new FakeClient();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(200, {
            active: true,
            live_tx_hash: "0x" + "22".repeat(32),
            live_index: 0,
            ckb_address: "ckt1qsomeoneelse",
          }),
        ),
      );
      const keyFile = join(dir, "signer.key");
      writeFileSync(keyFile, OWNER_PRIVATE_KEY, "utf8");

      await expect(
        runWithdraw("0xunid", {
          api: "http://api.test/api/v1",
          key: "test-key",
          mode: "non-custodial",
          signerKeyFile: keyFile,
        }),
      ).rejects.toThrow(/does not own/);
    });

    it("builds, signs, and broadcasts the withdraw tx directly against the chain", async () => {
      fakeClient = new FakeClient();
      const signer = new ccc.SignerCkbPrivateKey(fakeClient, OWNER_PRIVATE_KEY);
      await signer.connect();
      const lock = (await signer.getRecommendedAddressObj()).script;
      const ownerAddress = ccc.Address.fromScript(lock, fakeClient).toString();

      const liveTxHash = "0x" + "33".repeat(32);
      fakeClient.addLiveCell({
        outPoint: { txHash: liveTxHash, index: 0 },
        cellOutput: { capacity: ccc.fixedPointFrom(500), lock },
        outputData: "0x",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(200, {
            active: true,
            live_tx_hash: liveTxHash,
            live_index: 0,
            ckb_address: ownerAddress,
          }),
        ),
      );

      const keyFile = join(dir, "signer.key");
      writeFileSync(keyFile, OWNER_PRIVATE_KEY, "utf8");

      await runWithdraw("0xunid", {
        api: "http://api.test/api/v1",
        key: "test-key",
        mode: "non-custodial",
        signerKeyFile: keyFile,
        json: true,
      });

      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
        tx_hash: string;
        refund_capacity: string;
      };
      expect(printed.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(printed.refund_capacity)).toBeGreaterThan(0n);

      // The consuming tx is now on the FakeClient — the old cell is spent.
      const stillLive = await fakeClient.getCellLive({ txHash: liveTxHash, index: 0 }, false);
      expect(stillLive).toBeUndefined();
    });
  });

  it("rejects an invalid --mode value", async () => {
    await expect(
      runWithdraw("0xunid", { api: "http://api.test/api/v1", key: "test-key", mode: "bogus" }),
    ).rejects.toThrow(CliError);
  });
});
