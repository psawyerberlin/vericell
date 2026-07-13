/**
 * Phase 5 acceptance: offckb integration suite for the authenticated write
 * API (`/proofs*`, `/keys`). Reuses the same devnet setup as `chain`'s and
 * the indexer's own offckb suites — see those files' header comments for
 * the full setup steps. In short:
 *
 *   1. `offckb node` (RPC proxy at http://127.0.0.1:28114 by default).
 *   2. `VERICELL_OFFCKB_PRIVATE_KEY` = a funded devnet account's private key.
 *   3. `VERICELL_DEVNET_SCRIPTS_FILE` = path to
 *      `offckb system-scripts --export-style ccc --network devnet` output.
 *   4. `OFFCKB=1 pnpm --filter api test` (or `pnpm --filter api test:offckb`)
 *
 * Skipped entirely unless `OFFCKB=1`.
 *
 * This suite and `../indexer/offckb.integration.test.ts` run as separate
 * vitest files in the same `test:offckb` invocation; the api package's
 * `vitest.config.ts` disables file parallelism under `OFFCKB=1` so they
 * never build transactions against the same devnet account concurrently
 * (concurrent input selection against one account's cells causes 502
 * TransactionFailedToResolve). If a second funded devnet account is
 * available, set `VERICELL_OFFCKB_PRIVATE_KEY_PROOFS` to give this suite its
 * own account instead of sharing the default one with the indexer suite —
 * belt-and-suspenders on top of the serialized run, not a requirement.
 *
 * The `Indexer` here (used only to flip pending -> committed after a
 * broadcast) walks from `INDEXER_START_BLOCK` if set, else genesis — same
 * env var and rationale as `indexer/offckb.integration.test.ts`, for a
 * long-running local devnet.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ccc } from "@ckb-ccc/ccc";
import { makeClient } from "chain";
import { sha256Hex } from "core";
import { openDb } from "../db/open.js";
import { Indexer } from "../indexer/indexer.js";
import { hashApiKey } from "./auth.js";
import { buildServer, type TypedApp } from "./build.js";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";
const API_KEY = "vk_offckb_test_key_0123456789abcdef";
const ADMIN_TOKEN = "offckb-admin-token";

interface VersionStatusRow {
  status: string;
}

describe.skipIf(!OFFCKB_ENABLED)("write API against offckb devnet", () => {
  let client: ccc.Client;
  let signer: ccc.SignerCkbPrivateKey;
  let lock: ccc.Script;
  let db: Database.Database;
  let app: TypedApp;
  let indexer: Indexer;
  const runTag = Math.random().toString(36).slice(2, 10);
  const authHeaders = { authorization: `Bearer ${API_KEY}` };

  beforeAll(async () => {
    const privateKey =
      globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY_PROOFS ??
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

    client = makeClient("devnet");
    signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    await signer.connect();
    lock = (await signer.getRecommendedAddressObj()).script;

    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
    ).run(hashApiKey(API_KEY), "offckb-test", new Date().toISOString(), 1000);

    app = buildServer({
      db,
      network: "devnet",
      chainClient: () => client,
      adminToken: ADMIN_TOKEN,
      rateLimit: { max: 1000, timeWindow: "1 minute" },
    });

    const startBlock = BigInt(globalThis.process?.env?.INDEXER_START_BLOCK ?? 0);
    indexer = new Indexer({ db, client, startBlock });
  }, 60000);

  async function manifestDraft(title: string, fileTag: string) {
    return {
      title,
      files: [{ p: "file.txt", h: await sha256Hex(new TextEncoder().encode(fileTag)) }],
    };
  }

  it("401/403 auth failures never reach the chain", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      payload: { manifest: await manifestDraft("x", "x"), payer: { lock } },
    });
    expect(noAuth.statusCode).toBe(401);

    const badKey = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: "Bearer vk_not_real" },
      payload: { manifest: await manifestDraft("x", "x"), payer: { lock } },
    });
    expect(badKey.statusCode).toBe(401);

    const badAdmin = await app.inject({ method: "POST", url: "/api/v1/keys", payload: {} });
    expect(badAdmin.statusCode).toBe(401);
  });

  it("non-custodial: prepare -> sign locally -> submit -> indexer flips pending to committed", async () => {
    const draft = await manifestDraft(`Phase5 NC ${runTag}`, `${runTag}:nc`);

    const prepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { manifest: draft, payer: { lock } },
    });
    expect(prepareRes.statusCode).toBe(200);
    const prepared = prepareRes.json();
    expect(prepared.project_sha256).toMatch(/^[0-9a-f]{64}$/);

    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await signer.signTransaction(unsignedTx);
    const txJson = JSON.parse(ccc.stringify(signedTx)) as unknown;

    const submitRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: authHeaders,
      payload: { tx: txJson },
    });
    expect(submitRes.statusCode).toBe(202);
    const { tx_hash: txHash, unid } = submitRes.json();
    expect(unid).toBeTruthy();

    const pendingRow = db.prepare("SELECT status FROM versions WHERE tx_hash = ?").get(txHash) as
      VersionStatusRow | undefined;
    expect(pendingRow?.status).toBe("pending");

    await client.waitTransaction(txHash);
    await indexer.pollOnce();

    const committedRow = db.prepare("SELECT status FROM versions WHERE tx_hash = ?").get(txHash) as
      VersionStatusRow | undefined;
    expect(committedRow?.status).toBe("committed");

    const projectRow = db.prepare("SELECT active, unid FROM projects WHERE unid = ?").get(unid) as
      { active: number; unid: string } | undefined;
    expect(projectRow?.active).toBe(1);
  }, 240000);

  it("idempotent replay: a repeated Idempotency-Key never double-broadcasts", async () => {
    const draft = await manifestDraft(`Phase5 Idem ${runTag}`, `${runTag}:idem`);

    const prepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { manifest: draft, payer: { lock } },
    });
    const prepared = prepareRes.json();
    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await signer.signTransaction(unsignedTx);
    const txJson = JSON.parse(ccc.stringify(signedTx)) as unknown;

    const idemHeaders = { ...authHeaders, "idempotency-key": `idem-${runTag}` };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const versionCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM versions WHERE tx_hash = ?")
        .get(first.json().tx_hash) as {
        n: number;
      }
    ).n;
    expect(versionCount).toBe(1);

    await client.waitTransaction(first.json().tx_hash);
  }, 180000);

  it("non-custodial: anchor, new version, then withdraw — all via prepare -> sign -> submit", async () => {
    const draft = await manifestDraft(`Phase5 Chain ${runTag}`, `${runTag}:chain1`);

    const prepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { manifest: draft, payer: { lock } },
    });
    expect(prepareRes.statusCode).toBe(200);
    const prepared = prepareRes.json();
    const signedTx = await signer.signTransaction(ccc.Transaction.from(prepared.tx));
    const submitRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: authHeaders,
      payload: { tx: JSON.parse(ccc.stringify(signedTx)) as unknown },
    });
    expect(submitRes.statusCode).toBe(202);
    const { tx_hash: v1TxHash, unid } = submitRes.json();
    await client.waitTransaction(v1TxHash);

    const v2Draft = await manifestDraft(`Phase5 Chain v2 ${runTag}`, `${runTag}:chain2`);
    const v2PrepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { manifest: v2Draft, payer: { lock }, prev_tx_hash: v1TxHash },
    });
    expect(v2PrepareRes.statusCode).toBe(200);
    const v2Prepared = v2PrepareRes.json();
    const v2SignedTx = await signer.signTransaction(ccc.Transaction.from(v2Prepared.tx));
    const v2SubmitRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: authHeaders,
      payload: { tx: JSON.parse(ccc.stringify(v2SignedTx)) as unknown },
    });
    expect(v2SubmitRes.statusCode).toBe(202);
    const v2Body = v2SubmitRes.json();
    expect(v2Body.unid).toBe(unid);
    await client.waitTransaction(v2Body.tx_hash);

    const withdrawPrepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { withdraw_tx_hash: v2Body.tx_hash },
    });
    expect(withdrawPrepareRes.statusCode).toBe(200);
    const withdrawPrepared = withdrawPrepareRes.json();
    expect(BigInt(withdrawPrepared.refund_capacity)).toBeGreaterThan(0n);
    const withdrawSignedTx = await signer.signTransaction(
      ccc.Transaction.from(withdrawPrepared.tx),
    );
    const withdrawSubmitRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: authHeaders,
      payload: { tx: JSON.parse(ccc.stringify(withdrawSignedTx)) as unknown },
    });
    expect(withdrawSubmitRes.statusCode).toBe(202);
    const withdrawBody = withdrawSubmitRes.json();
    expect(BigInt(withdrawBody.refund_capacity)).toBeGreaterThan(0n);
    await client.waitTransaction(withdrawBody.tx_hash);

    await indexer.pollOnce();

    const projectRow = db
      .prepare("SELECT active, live_tx_hash FROM projects WHERE unid = ?")
      .get(unid) as { active: number; live_tx_hash: string | null } | undefined;
    expect(projectRow?.active).toBe(0);
  }, 300000);
});
