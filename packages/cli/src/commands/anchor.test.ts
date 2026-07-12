import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnchorTxWithTypeId, ccc, FakeClient } from "chain";
import { ManifestSchema, encodeManifest, merkleRoot, projectHash, type Manifest } from "core";
import { CliError } from "../lib/cliError.js";
import { runAnchor } from "./anchor.js";

// `runAnchor`'s non-custodial branch calls `makeClient()` (no args) itself —
// intercepted here so it resolves to a shared FakeClient instead of trying
// to reach a real network. Mirrors packages/api's own route tests, which
// inject a FakeClient the same way via `buildServer({ chainClient: ... })`.
let fakeClient: FakeClient | undefined;
vi.mock("chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chain")>();
  return { ...actual, makeClient: () => fakeClient };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const PAYER_PRIVATE_KEY = "0x" + "ab".repeat(32);

async function buildManifest(title: string): Promise<Manifest> {
  const entries = [{ path: "a.txt", hash: "a".repeat(64) }];
  return ManifestSchema.parse({
    app: "vericell",
    v: 1,
    title,
    created: new Date().toISOString(),
    project_sha256: await projectHash(entries),
    merkle_root: await merkleRoot(entries),
    count: 1,
    files: [{ p: "a.txt", h: "a".repeat(64) }],
  });
}

describe("runAnchor", () => {
  let dir: string;
  let manifestPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vericell-anchor-cmd-test-"));
    manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(await buildManifest("Test Project")));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    fakeClient = undefined;
  });

  it("rejects an invalid --mode value", async () => {
    await expect(
      runAnchor(manifestPath, { api: "http://api.test/api/v1", key: "k", mode: "bogus" }),
    ).rejects.toThrow(CliError);
  });

  it("rejects a --compact (files-less) manifest with a clear message", async () => {
    const compactPath = join(dir, "compact.json");
    const manifest = await buildManifest("Compact");
    delete (manifest as { files?: unknown }).files;
    writeFileSync(compactPath, JSON.stringify(manifest));

    await expect(
      runAnchor(compactPath, {
        api: "http://api.test/api/v1",
        key: "k",
        mode: "non-custodial",
        signerKeyFile: join(dir, "key"),
      }),
    ).rejects.toThrow(/--compact/);
  });

  describe("non-custodial", () => {
    it("requires --signer-key-file", async () => {
      await expect(
        runAnchor(manifestPath, { api: "http://api.test/api/v1", key: "k", mode: "non-custodial" }),
      ).rejects.toThrow(/--signer-key-file/);
    });

    it("prepares, signs locally, and submits — never sending the key over the network", async () => {
      fakeClient = new FakeClient();
      const signer = new ccc.SignerCkbPrivateKey(fakeClient, PAYER_PRIVATE_KEY);
      await signer.connect();
      const lock = (await signer.getRecommendedAddressObj()).script;
      fakeClient.addLiveCell({
        outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
        cellOutput: { capacity: ccc.fixedPointFrom(100_000), lock },
        outputData: "0x",
      });

      const keyFile = join(dir, "signer.key");
      writeFileSync(keyFile, PAYER_PRIVATE_KEY, "utf8");

      const manifest = await buildManifest("Test Project");
      const { tx } = await buildAnchorTxWithTypeId({
        client: fakeClient,
        lock,
        manifestBytes: encodeManifest(manifest),
      });

      const fetchMock = vi
        .fn()
        .mockImplementation((url: string, init: NonNullable<Parameters<typeof fetch>[1]>) => {
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          expect(init.headers).toMatchObject({ authorization: "Bearer test-key" });
          // The private key must never appear in any outgoing request body.
          expect(JSON.stringify(body)).not.toContain(PAYER_PRIVATE_KEY.slice(2));

          if (url.endsWith("/proofs/prepare")) {
            return Promise.resolve(
              jsonResponse(200, {
                tx: JSON.parse(ccc.stringify(tx)),
                capacity: tx.outputs[0]!.capacity.toString(),
                project_sha256: manifest.project_sha256,
              }),
            );
          }
          if (url.endsWith("/proofs/submit")) {
            const signedTx = ccc.Transaction.from(body.tx as ccc.TransactionLike);
            const txHash = signedTx.hash();
            fakeClient!.addLiveCell({
              outPoint: { txHash, index: 0 },
              cellOutput: signedTx.outputs[0]!,
              outputData: signedTx.outputsData[0]!,
            });
            return Promise.resolve(
              jsonResponse(202, { tx_hash: txHash, unid: tx.outputs[0]!.type!.args }),
            );
          }
          throw new Error(`unexpected fetch to ${url}`);
        });
      vi.stubGlobal("fetch", fetchMock);

      await runAnchor(manifestPath, {
        api: "http://api.test/api/v1",
        key: "test-key",
        mode: "non-custodial",
        signerKeyFile: keyFile,
        json: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as { tx_hash: string };
      expect(printed.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("custodial", () => {
    it("requires manifest.declared_author", async () => {
      await expect(
        runAnchor(manifestPath, { api: "http://api.test/api/v1", key: "k", mode: "custodial" }),
      ).rejects.toThrow(/declared_author/);
    });

    it("POSTs to /proofs with declared_author", async () => {
      const authoredPath = join(dir, "authored.json");
      const manifest = await buildManifest("Authored");
      writeFileSync(authoredPath, JSON.stringify({ ...manifest, declared_author: "alice" }));

      const fetchMock = vi
        .fn()
        .mockImplementation((url: string, init: NonNullable<Parameters<typeof fetch>[1]>) => {
          expect(url).toBe("http://api.test/api/v1/proofs");
          const body = JSON.parse(init.body as string) as { manifest: { declared_author: string } };
          expect(body.manifest.declared_author).toBe("alice");
          return Promise.resolve(
            jsonResponse(202, { tx_hash: "0xabc", unid: "0xunid", note: "custodial trade-off" }),
          );
        });
      vi.stubGlobal("fetch", fetchMock);

      await runAnchor(authoredPath, {
        api: "http://api.test/api/v1",
        key: "test-key",
        mode: "custodial",
      });

      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/0xabc/);
      expect(printed).toMatch(/custodial trade-off/);
    });

    it("resolves --prev's unid via GET /versions and POSTs to /proofs/{unid}/versions", async () => {
      const authoredPath = join(dir, "authored.json");
      const manifest = await buildManifest("Authored v2");
      writeFileSync(authoredPath, JSON.stringify({ ...manifest, declared_author: "alice" }));

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/versions/0xprevtx")) {
          return Promise.resolve(jsonResponse(200, { unid: "0xunid" }));
        }
        if (url.endsWith("/proofs/0xunid/versions")) {
          return Promise.resolve(jsonResponse(202, { tx_hash: "0xnew", unid: "0xunid" }));
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await runAnchor(authoredPath, {
        api: "http://api.test/api/v1",
        key: "test-key",
        mode: "custodial",
        prev: "0xprevtx",
      });

      expect(logSpy.mock.calls.flat().join("\n")).toMatch(/0xnew/);
    });

    it("wraps an API error as a CliError", async () => {
      const authoredPath = join(dir, "authored.json");
      const manifest = await buildManifest("Authored");
      writeFileSync(authoredPath, JSON.stringify({ ...manifest, declared_author: "alice" }));

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse(403, { title: "Forbidden", detail: "Custodial mode is disabled" }),
          ),
      );

      await expect(
        runAnchor(authoredPath, {
          api: "http://api.test/api/v1",
          key: "test-key",
          mode: "custodial",
        }),
      ).rejects.toThrow(/Custodial mode is disabled/);
    });
  });
});
