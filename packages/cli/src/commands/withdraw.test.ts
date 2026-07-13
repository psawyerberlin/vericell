import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ccc, FakeClient } from "chain";
import { runWithdraw } from "./withdraw.js";

// Mirrors anchor.test.ts's approach: `runWithdraw` calls `makeClient()`
// itself, intercepted here to resolve to a shared FakeClient instead of a
// real network connection.
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

  it("requires --signer-key-file", async () => {
    await expect(
      runWithdraw("0xunid", { api: "http://api.test/api/v1", key: "test-key" }),
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
        signerKeyFile: keyFile,
      }),
    ).rejects.toThrow(/does not own/);
  });

  it("prepares, signs locally, and submits a withdraw — printing the refund", async () => {
    fakeClient = new FakeClient();
    const signer = new ccc.SignerCkbPrivateKey(fakeClient, OWNER_PRIVATE_KEY);
    await signer.connect();
    const lock = (await signer.getRecommendedAddressObj()).script;
    const ownerAddress = ccc.Address.fromScript(lock, fakeClient).toString();

    const liveTxHash = "0x" + "33".repeat(32);
    const liveCell = fakeClient.addLiveCell({
      outPoint: { txHash: liveTxHash, index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(500), lock },
      outputData: "0x",
    });

    const keyFile = join(dir, "signer.key");
    writeFileSync(keyFile, OWNER_PRIVATE_KEY, "utf8");

    const withdrawTx = ccc.Transaction.from({
      inputs: [{ previousOutput: liveCell.outPoint }],
      outputs: [{ lock, capacity: ccc.fixedPointFrom(499) }],
      outputsData: ["0x"],
    });

    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: NonNullable<Parameters<typeof fetch>[1]>) => {
        if (url.endsWith("/projects/0xunid")) {
          return Promise.resolve(
            jsonResponse(200, {
              active: true,
              live_tx_hash: liveTxHash,
              live_index: 0,
              ckb_address: ownerAddress,
            }),
          );
        }
        if (url.endsWith("/proofs/prepare")) {
          const body = JSON.parse(init!.body as string) as { withdraw_tx_hash: string };
          expect(body.withdraw_tx_hash).toBe(liveTxHash);
          return Promise.resolve(
            jsonResponse(200, {
              tx: JSON.parse(ccc.stringify(withdrawTx)),
              refund_capacity: withdrawTx.outputs[0]!.capacity.toString(),
            }),
          );
        }
        if (url.endsWith("/proofs/submit")) {
          const signedTx = ccc.Transaction.from(
            (JSON.parse(init!.body as string) as { tx: ccc.TransactionLike }).tx,
          );
          return Promise.resolve(
            jsonResponse(202, {
              tx_hash: signedTx.hash(),
              unid: "0xunid",
              refund_capacity: signedTx.outputs[0]!.capacity.toString(),
            }),
          );
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
    vi.stubGlobal("fetch", fetchMock);

    await runWithdraw("0xunid", {
      api: "http://api.test/api/v1",
      key: "test-key",
      signerKeyFile: keyFile,
      json: true,
    });

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      tx_hash: string;
      refund_capacity: string;
    };
    expect(printed.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(printed.refund_capacity)).toBeGreaterThan(0n);
  });

  it("wraps an API error as a CliError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { title: "Not Found", detail: "No live project" })),
    );
    const keyFile = join(dir, "signer.key");
    writeFileSync(keyFile, OWNER_PRIVATE_KEY, "utf8");

    await expect(
      runWithdraw("does-not-exist", {
        api: "http://api.test/api/v1",
        key: "test-key",
        signerKeyFile: keyFile,
      }),
    ).rejects.toThrow(/No live project/);
  });
});
