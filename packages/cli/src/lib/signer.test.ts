import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClient } from "chain";
import { loadSigner } from "./signer.js";

describe("loadSigner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vericell-signer-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and connects a signer from a 0x-prefixed key file", async () => {
    const keyFile = join(dir, "signer.key");
    writeFileSync(keyFile, "0x" + "ab".repeat(32), "utf8");

    const client = new FakeClient();
    const signer = await loadSigner(client, keyFile);
    const address = await signer.getRecommendedAddressObj();
    expect(address.script.args).toBeTruthy();
  });

  it("accepts a key file without the 0x prefix", async () => {
    const keyFile = join(dir, "signer.key");
    writeFileSync(keyFile, "cd".repeat(32), "utf8");

    const client = new FakeClient();
    const signer = await loadSigner(client, keyFile);
    expect(signer.privateKey).toBe("0x" + "cd".repeat(32));
  });

  it("tolerates surrounding whitespace/newlines in the key file", async () => {
    const keyFile = join(dir, "signer.key");
    writeFileSync(keyFile, `  0x${"ef".repeat(32)}\n`, "utf8");

    const client = new FakeClient();
    const signer = await loadSigner(client, keyFile);
    expect(signer.privateKey).toBe("0x" + "ef".repeat(32));
  });

  it("throws a clear error for an empty key file", async () => {
    const keyFile = join(dir, "empty.key");
    writeFileSync(keyFile, "   \n", "utf8");

    const client = new FakeClient();
    await expect(loadSigner(client, keyFile)).rejects.toThrow(/empty/);
  });
});
