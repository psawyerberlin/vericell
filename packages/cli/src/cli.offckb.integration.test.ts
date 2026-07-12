/**
 * Phase 8 acceptance: CLI e2e suite driving the compiled `vericell` binary
 * with execa against a real Fastify API (in-process, temp in-memory DB) and
 * a real offckb devnet. Reuses the same devnet setup as every other offckb
 * suite in this repo — see e.g. `packages/chain/src/offckb.integration.test.ts`'s
 * header comment for the full setup steps. In short:
 *
 *   1. `offckb node` (RPC proxy at http://127.0.0.1:28114 by default).
 *   2. `VERICELL_OFFCKB_PRIVATE_KEY` = a funded devnet account's private key.
 *   3. `VERICELL_DEVNET_SCRIPTS_FILE` = path to
 *      `offckb system-scripts --export-style ccc --network devnet` output.
 *   4. `OFFCKB=1 pnpm --filter cli test:offckb`
 *
 * Skipped entirely unless `OFFCKB=1`. The API server is a real HTTP listener
 * on an ephemeral port (not `inject()` — the CLI runs as a separate process
 * and needs a real URL to hit), backed by an in-memory DB and a throwaway
 * ADMIN_TOKEN, both created fresh in `beforeAll`; a real API key is minted
 * through that admin-token flow, exactly as a human operator would. The CLI
 * itself is rebuilt at the start of the suite so it never runs against a
 * stale `dist/`.
 *
 * This suite builds/broadcasts transactions against the same funded devnet
 * account as `packages/chain` and `packages/api`'s offckb suites; run it
 * alone rather than concurrently with those, for the same
 * TransactionFailedToResolve race documented in `docs/DECISIONS.md`'s
 * "Phase 5" entry — this package's `vitest.config.ts` mirrors `api`'s in
 * disabling file parallelism under `OFFCKB=1`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { ccc } from "@ckb-ccc/ccc";
import { buildServer, Indexer, openDb, type TypedApp } from "api";
import { makeClient } from "chain";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const CLI_BIN = join(PACKAGE_ROOT, "dist/index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Unlike `chain`'s/`api`'s offckb suites (which call `makeClient("devnet")`
 * directly in-process), the CLI is a real subprocess that resolves its
 * network from `VERICELL_NETWORK` via `core`'s env-based default (which is
 * "testnet", not "devnet" — see `packages/core/src/network.ts`). It's set
 * explicitly here rather than relying on the test runner's ambient
 * environment, since without it the CLI would silently sign against public
 * testnet infrastructure instead of the local devnet.
 */
async function runCli(args: string[]): Promise<CliResult> {
  const result = await execa("node", [CLI_BIN, ...args], {
    reject: false,
    env: { ...globalThis.process.env, VERICELL_NETWORK: "devnet" },
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

describe.skipIf(!OFFCKB_ENABLED)("vericell CLI against offckb devnet", () => {
  let client: ccc.Client;
  let db: ReturnType<typeof openDb>;
  let app: TypedApp;
  let indexer: Indexer;
  let apiUrl: string;
  let apiKey: string;
  let signerKeyFile: string;
  let fixtureDir: string;
  const scratchDir = mkdtempSync(join(tmpdir(), "vericell-cli-e2e-"));

  beforeAll(async () => {
    const privateKey =
      globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY_CLI ??
      globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_OFFCKB_PRIVATE_KEY to be set to a funded devnet account's private key.",
      );
    }
    if (!globalThis.process?.env?.VERICELL_DEVNET_SCRIPTS_FILE) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_DEVNET_SCRIPTS_FILE (see this file's header comment).",
      );
    }

    await execa("pnpm", ["--filter", "cli", "build"], { cwd: REPO_ROOT });

    client = makeClient("devnet");
    const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    await signer.connect();

    signerKeyFile = join(scratchDir, "signer.key");
    writeFileSync(signerKeyFile, privateKey, "utf8");

    db = openDb(":memory:", "devnet");
    const adminToken = "cli-e2e-admin-token";

    app = buildServer({
      db,
      network: "devnet",
      chainClient: () => client,
      adminToken,
      custodialEnabled: false,
      rateLimit: { max: 1000, timeWindow: "1 minute" },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("API server did not bind a TCP port");
    }
    apiUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const keyRes = await fetch(`${apiUrl}/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "cli-e2e" }),
    });
    if (!keyRes.ok) {
      throw new Error(`failed to mint a test API key: ${keyRes.status} ${await keyRes.text()}`);
    }
    apiKey = ((await keyRes.json()) as { key: string }).key;

    const startBlock = BigInt(globalThis.process?.env?.INDEXER_START_BLOCK ?? 0);
    indexer = new Indexer({ db, client, startBlock });

    fixtureDir = join(scratchDir, "fixture");
    mkdirSync(join(fixtureDir, "sub"), { recursive: true });
    writeFileSync(join(fixtureDir, "a.txt"), "vericell fixture file a\n");
    writeFileSync(join(fixtureDir, "sub", "b.txt"), "vericell fixture file b\n");
    writeFileSync(join(fixtureDir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(fixtureDir, "ignored.txt"), "should not be hashed\n");
  }, 120000);

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("hash produces a deterministic project_sha256 and respects .gitignore", async () => {
    const first = await runCli(["hash", fixtureDir, "--json"]);
    expect(first.exitCode).toBe(0);
    const second = await runCli(["hash", fixtureDir, "--json"]);
    expect(second.exitCode).toBe(0);

    const firstManifest = JSON.parse(first.stdout) as {
      project_sha256: string;
      count: number;
      files: { p: string }[];
    };
    const secondManifest = JSON.parse(second.stdout) as { project_sha256: string };

    expect(firstManifest.project_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstManifest.project_sha256).toBe(secondManifest.project_sha256);
    // ignored.txt is excluded by the fixture's .gitignore; the .gitignore
    // file itself is a normal tracked file (nothing ignores it), same as a
    // real git working tree.
    expect(firstManifest.count).toBe(3);
    expect(firstManifest.files.map((f) => f.p).sort()).toEqual([
      ".gitignore",
      "a.txt",
      "sub/b.txt",
    ]);
  });

  it("full non-custodial anchor via the CLI, then verify returns exit 0", async () => {
    const manifestPath = join(scratchDir, "manifest.json");
    const hashRes = await runCli(["hash", fixtureDir, "--out", manifestPath]);
    expect(hashRes.exitCode).toBe(0);

    const anchorRes = await runCli([
      "anchor",
      manifestPath,
      "--api",
      apiUrl,
      "--key",
      apiKey,
      "--mode",
      "non-custodial",
      "--signer-key-file",
      signerKeyFile,
      "--json",
    ]);
    expect(anchorRes.exitCode).toBe(0);
    const anchored = JSON.parse(anchorRes.stdout) as { tx_hash: string; unid: string };
    expect(anchored.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

    await client.waitTransaction(anchored.tx_hash);
    await indexer.pollOnce();

    const verifyRes = await runCli(["verify", join(fixtureDir, "a.txt"), "--api", apiUrl]);
    expect(verifyRes.exitCode).toBe(0);
    expect(verifyRes.stdout).toMatch(/LIVE/);

    const statusRes = await runCli(["status", anchored.unid, "--api", apiUrl, "--json"]);
    expect(statusRes.exitCode).toBe(0);
    const status = JSON.parse(statusRes.stdout) as { active: boolean; unid: string };
    expect(status.active).toBe(true);
    expect(status.unid).toBe(anchored.unid);
  }, 180000);

  it("verify of an un-anchored file returns exit 1, and --json output parses", async () => {
    const strayFile = join(scratchDir, "never-anchored.txt");
    writeFileSync(strayFile, `not anchored ${Math.random()}\n`);

    const res = await runCli(["verify", strayFile, "--api", apiUrl, "--json"]);
    expect(res.exitCode).toBe(1);

    const body = JSON.parse(res.stdout) as { found: boolean; sha256: string };
    expect(body.found).toBe(false);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
