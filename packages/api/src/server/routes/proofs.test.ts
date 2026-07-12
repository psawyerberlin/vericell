import { beforeEach, describe, expect, it } from "vitest";
import { ccc, FakeClient, type ProofResult } from "chain";
import { openDb } from "../../db/open.js";
import { hashApiKey } from "../auth.js";
import { buildServer, type TypedApp } from "../build.js";
import type { GetCustodialSignerFn } from "../chainClient.js";
import type { FetchProofFn } from "../chainLookup.js";

// A fixed test-only private key — never used for anything but FakeClient
// fixtures. FakeClient doesn't verify witness signatures, so its exact
// value is irrelevant beyond deriving a stable lock/address.
const PAYER_PRIVATE_KEY = "0x" + "ab".repeat(32);
const SERVICE_PRIVATE_KEY = "0x" + "cd".repeat(32);

const API_KEY = "vk_test_0123456789abcdef0123456789abcdef";
const API_KEY_HASH = hashApiKey(API_KEY);
const ADMIN_TOKEN = "admin-secret-test-token";

function seedWalletCapacity(
  client: FakeClient,
  lock: ccc.ScriptLike,
  txHash: string,
  capacityCkb: number,
): ccc.Cell {
  return client.addLiveCell({
    outPoint: { txHash, index: 0 },
    cellOutput: { capacity: ccc.fixedPointFrom(capacityCkb), lock },
    outputData: "0x",
  });
}

interface Setup {
  app: TypedApp;
  client: FakeClient;
  payerLock: ccc.Script;
  payerSigner: ccc.SignerCkbPrivateKey;
  serviceLock: ccc.Script;
}

/** Default `fetchProofFromChain` for tests that never need a real chain-lookup answer. */
const NULL_PROOF: ProofResult = {
  manifest: null,
  live: null,
  blockNumber: null,
  blockTime: null,
  ownerAddress: null,
};

async function setup(
  opts: { custodialEnabled?: boolean; fetchProof?: FetchProofFn } = {},
): Promise<Setup> {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
  ).run(API_KEY_HASH, "test", new Date().toISOString(), 1000);

  const client = new FakeClient();

  const payerSigner = new ccc.SignerCkbPrivateKey(client, PAYER_PRIVATE_KEY);
  await payerSigner.connect();
  const payerLock = (await payerSigner.getRecommendedAddressObj()).script;
  seedWalletCapacity(client, payerLock, "0x" + "11".repeat(32), 100_000);

  const custodialSigner: GetCustodialSignerFn = async () => {
    const signer = new ccc.SignerCkbPrivateKey(client, SERVICE_PRIVATE_KEY);
    await signer.connect();
    return signer;
  };
  const serviceLock = (await (await custodialSigner()).getRecommendedAddressObj()).script;
  seedWalletCapacity(client, serviceLock, "0x" + "22".repeat(32), 100_000);

  const app = buildServer({
    db,
    network: "devnet",
    chainClient: () => client,
    fetchProof: opts.fetchProof ?? (async () => NULL_PROOF),
    adminToken: ADMIN_TOKEN,
    custodialEnabled: opts.custodialEnabled ?? false,
    custodialSigner,
    rateLimit: { max: 1000, timeWindow: "1 minute" },
  });

  return { app, client, payerLock, payerSigner, serviceLock };
}

const MANIFEST_DRAFT = {
  title: "Test Project",
  files: [{ p: "a.txt", h: "a".repeat(64) }],
};

describe("POST /api/v1/proofs/prepare", () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("401s without a bearer key", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("401s with an unrecognized key", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: "Bearer vk_not_a_real_key" },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns an unsigned tx, capacity, and computed project_sha256", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tx.outputs.length).toBeGreaterThanOrEqual(1);
    expect(body.tx.outputs[0].lock.args).toBe(ctx.payerLock.args);
    expect(typeof body.capacity).toBe("string");
    expect(BigInt(body.capacity)).toBeGreaterThan(0n);
    expect(body.project_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.manifest.title).toBe("Test Project");
    // First version, no prev_tx_hash: Type ID by default (TECHNICAL.md §5).
    expect(body.tx.outputs[0].type).toBeDefined();
  });

  it("400s on a malformed body (missing files)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: { title: "x", files: [] }, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("resolves the payer from payer.address (not just payer.lock)", async () => {
    const address = (await ctx.payerSigner.getRecommendedAddressObj()).toString();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { address } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tx.outputs[0].lock.args).toBe(ctx.payerLock.args);
  });
});

describe("POST /api/v1/proofs/prepare — new version (prev_tx_hash)", () => {
  async function anchorV1(ctx: Setup): Promise<{ txHash: string; manifest: unknown }> {
    const prepareRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    const prepared = prepareRes.json();
    const signedTx = await ctx.payerSigner.signTransaction(ccc.Transaction.from(prepared.tx));
    const submitRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: JSON.parse(ccc.stringify(signedTx)) as unknown },
    });
    return { txHash: submitRes.json().tx_hash as string, manifest: prepared.manifest };
  }

  it("consumes the previous live cell and links genesis/prev, carrying Type ID over", async () => {
    const proofs = new Map<string, ProofResult>();
    const ctx = await setup({ fetchProof: async (txHash) => proofs.get(txHash) ?? NULL_PROOF });
    const { txHash: v1TxHash, manifest: v1Manifest } = await anchorV1(ctx);
    proofs.set(v1TxHash, {
      manifest: v1Manifest as ProofResult["manifest"],
      live: true,
      blockNumber: 1n,
      blockTime: new Date(),
      ownerAddress: ccc.Address.fromScript(ctx.payerLock, ctx.client).toString(),
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        manifest: { title: "v2", files: [{ p: "a.txt", h: "c".repeat(64) }] },
        payer: { lock: ctx.payerLock },
        prev_tx_hash: v1TxHash,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.manifest.genesis).toBe(v1TxHash);
    expect(body.manifest.prev).toBe(v1TxHash);
    expect(body.tx.inputs[0].previousOutput.txHash).toBe(v1TxHash);
    // Type ID carried over from v1, per buildAnchorTxWithTypeId's update branch.
    expect(body.tx.outputs[0].type).toBeDefined();
  });

  it("anchors a successor to a legacy (no Type ID) prev cell via the plain consuming builder", async () => {
    const proofs = new Map<string, ProofResult>();
    const ctx = await setup({ fetchProof: async (txHash) => proofs.get(txHash) ?? NULL_PROOF });

    // A pre-Type-ID v1 cell: seeded directly (no `type` script), rather than
    // through a real anchor (which always attaches Type ID on this server).
    const legacyTxHash = "0x" + "77".repeat(32);
    ctx.client.addLiveCell({
      outPoint: { txHash: legacyTxHash, index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(500), lock: ctx.payerLock },
      outputData: "0x",
    });
    proofs.set(legacyTxHash, {
      manifest: {
        app: "vericell",
        v: 1,
        title: "legacy",
        created: new Date().toISOString(),
      } as never,
      live: true,
      blockNumber: 1n,
      blockTime: new Date(),
      ownerAddress: ccc.Address.fromScript(ctx.payerLock, ctx.client).toString(),
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        manifest: MANIFEST_DRAFT,
        payer: { lock: ctx.payerLock },
        prev_tx_hash: legacyTxHash,
      },
    });
    expect(res.statusCode).toBe(200);
    // No Type ID: buildAnchorTx (not buildAnchorTxWithTypeId) built this tx.
    expect(res.json().tx.outputs[0].type).toBeUndefined();
  });

  it("404s when prev_tx_hash has no proof on chain", async () => {
    const ctx = await setup({ fetchProof: async () => NULL_PROOF });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        manifest: MANIFEST_DRAFT,
        payer: { lock: ctx.payerLock },
        prev_tx_hash: "0x" + "99".repeat(32),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s when prev_tx_hash is not live (already superseded or withdrawn)", async () => {
    const deadTxHash = "0x" + "88".repeat(32);
    const proofs = new Map<string, ProofResult>([
      [
        deadTxHash,
        {
          manifest: {
            app: "vericell",
            v: 1,
            title: "dead",
            created: new Date().toISOString(),
          } as never,
          live: false,
          blockNumber: 1n,
          blockTime: new Date(),
          ownerAddress: null,
        },
      ],
    ]);
    const ctx = await setup({ fetchProof: async (txHash) => proofs.get(txHash) ?? NULL_PROOF });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        manifest: MANIFEST_DRAFT,
        payer: { lock: ctx.payerLock },
        prev_tx_hash: deadTxHash,
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s when the chain says prev_tx_hash is live but its cell can't be located", async () => {
    // fetchProofFromChain (indexer/RPC-derived) says it's live, but the raw
    // client.getCell lookup this FakeClient backs comes up empty — a
    // genuinely inconsistent-state edge case, not just "not found at all".
    const ghostTxHash = "0x" + "66".repeat(32);
    const proofs = new Map<string, ProofResult>([
      [
        ghostTxHash,
        {
          manifest: {
            app: "vericell",
            v: 1,
            title: "ghost",
            created: new Date().toISOString(),
          } as never,
          live: true,
          blockNumber: 1n,
          blockTime: new Date(),
          ownerAddress: null,
        },
      ],
    ]);
    const ctx = await setup({ fetchProof: async (txHash) => proofs.get(txHash) ?? NULL_PROOF });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        manifest: MANIFEST_DRAFT,
        payer: { lock: ctx.payerLock },
        prev_tx_hash: ghostTxHash,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Idempotency-Key reused across a different method/path", () => {
  it("409s rather than replaying the wrong route's response", async () => {
    const ctx = await setup();
    const idemHeaders = { authorization: `Bearer ${API_KEY}`, "idempotency-key": "cross-route-1" };

    const prepareRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: idemHeaders,
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(prepareRes.statusCode).toBe(200);

    // Same key, same caller, but a different method+path — a caller error,
    // not a cache hit (see idempotency.ts's getStoredResponse).
    const submitRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: prepareRes.json().tx },
    });
    expect(submitRes.statusCode).toBe(409);
  });
});

describe("POST /api/v1/proofs/submit", () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  async function prepareAndSign(): Promise<{ txJson: unknown; projectSha256: string }> {
    const prepareRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(prepareRes.statusCode).toBe(200);
    const prepared = prepareRes.json();

    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await ctx.payerSigner.signTransaction(unsignedTx);
    return {
      txJson: JSON.parse(ccc.stringify(signedTx)) as unknown,
      projectSha256: prepared.project_sha256,
    };
  }

  it("401s without a bearer key", async () => {
    const { txJson } = await prepareAndSign();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      payload: { tx: txJson },
    });
    expect(res.statusCode).toBe(401);
  });

  it("broadcasts the signed tx and inserts a pending version", async () => {
    const { txJson, projectSha256 } = await prepareAndSign();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: txJson },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.unid).toBeTruthy();

    const dbRow = ctx.app.db
      .prepare("SELECT status, project_sha256 FROM versions WHERE tx_hash = ?")
      .get(body.tx_hash) as { status: string; project_sha256: string } | undefined;
    expect(dbRow?.status).toBe("pending");
    expect(dbRow?.project_sha256).toBe(projectSha256);

    const projectRow = ctx.app.db
      .prepare("SELECT active, live_tx_hash FROM projects WHERE unid = ?")
      .get(body.unid) as { active: number; live_tx_hash: string } | undefined;
    expect(projectRow?.active).toBe(1);
    expect(projectRow?.live_tx_hash).toBe(body.tx_hash);
  });

  it("400s on an invalid transaction payload", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: { not: "a transaction" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when output 0's data isn't a valid VeriCell manifest", async () => {
    const tx = ccc.Transaction.from({
      outputs: [{ capacity: 10_000_000_000n, lock: ctx.payerLock }],
      outputsData: ["0x" + Buffer.from("not a manifest").toString("hex")],
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: JSON.parse(ccc.stringify(tx)) as unknown },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/not a valid VeriCell manifest/);
  });

  it("502s when broadcast fails (e.g. an input referencing a dead/unknown outpoint)", async () => {
    const { txJson } = await prepareAndSign();
    const tx = ccc.Transaction.from(txJson as ccc.TransactionLike);
    // Point the input at a cell FakeClient has never seen — mirrors a real
    // node's TransactionFailedToResolve.
    tx.inputs[0]!.previousOutput = ccc.OutPoint.from({
      txHash: "0x" + "ee".repeat(32),
      index: 0,
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: JSON.parse(ccc.stringify(tx)) as unknown },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().detail).toMatch(/Broadcast failed/);
  });

  it("Idempotency-Key replay returns the stored response without re-broadcasting", async () => {
    const { txJson } = await prepareAndSign();
    const idemHeaders = {
      authorization: `Bearer ${API_KEY}`,
      "idempotency-key": "replay-test-1",
    };

    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(first.statusCode).toBe(202);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const versionCount = (
      ctx.app.db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }
    ).n;
    expect(versionCount).toBe(1);
  });
});

describe("custodial proofs (CUSTODIAL_ENABLED)", () => {
  it("403s when custodial mode is disabled", async () => {
    const ctx = await setup({ custodialEnabled: false });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: { ...MANIFEST_DRAFT, declared_author: "alice" } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s when declared_author is missing", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT },
    });
    expect(res.statusCode).toBe(400);
  });

  it("anchors, adds a new version, and withdraws end to end", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const authHeaders = { authorization: `Bearer ${API_KEY}` };

    const anchorRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: authHeaders,
      payload: { manifest: { ...MANIFEST_DRAFT, declared_author: "alice" } },
    });
    expect(anchorRes.statusCode).toBe(202);
    const anchorBody = anchorRes.json();
    expect(anchorBody.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anchorBody.note).toMatch(/custodial/i);
    const { unid } = anchorBody;

    const versionRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/proofs/${unid}/versions`,
      headers: authHeaders,
      payload: {
        manifest: {
          title: "Test Project v2",
          files: [{ p: "a.txt", h: "b".repeat(64) }],
          declared_author: "alice",
        },
      },
    });
    expect(versionRes.statusCode).toBe(202);
    const versionBody = versionRes.json();
    expect(versionBody.unid).toBe(unid);
    expect(versionBody.tx_hash).not.toBe(anchorBody.tx_hash);

    const withdrawRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/proofs/${unid}`,
      headers: authHeaders,
    });
    expect(withdrawRes.statusCode).toBe(202);
    const withdrawBody = withdrawRes.json();
    expect(withdrawBody.unid).toBe(unid);
    expect(BigInt(withdrawBody.refund_capacity)).toBeGreaterThan(0n);

    const projectRow = ctx.app.db
      .prepare("SELECT active, live_tx_hash FROM projects WHERE unid = ?")
      .get(unid) as { active: number; live_tx_hash: string | null } | undefined;
    expect(projectRow?.active).toBe(0);
    expect(projectRow?.live_tx_hash).toBeNull();
  });

  it("404s withdrawing an unknown project", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/proofs/does-not-exist",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s adding a version to an unknown project", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/does-not-exist/versions",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: { ...MANIFEST_DRAFT, declared_author: "alice" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s versioning/withdrawing a project the service wallet doesn't own", async () => {
    const ctx = await setup({ custodialEnabled: true });
    // Anchored non-custodially (payer-owned lock), not via the service wallet.
    const prepareRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    const prepared = prepareRes.json();
    const signedTx = await ctx.payerSigner.signTransaction(ccc.Transaction.from(prepared.tx));
    const submitRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: JSON.parse(ccc.stringify(signedTx)) as unknown },
    });
    const { unid } = submitRes.json();

    const versionRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/proofs/${unid}/versions`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: { ...MANIFEST_DRAFT, declared_author: "alice" } },
    });
    expect(versionRes.statusCode).toBe(403);

    const withdrawRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/proofs/${unid}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(withdrawRes.statusCode).toBe(403);
  });
});

describe("POST /api/v1/keys", () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("401s without an admin token", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/keys", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401s with the wrong admin token", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { authorization: "Bearer wrong-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("mints a key shown once, stored only as a hash", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: "ci-bot", rate_limit: 120 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^vk_[0-9a-f]{64}$/);
    expect(body.key_hash).toBe(hashApiKey(body.key));
    expect(body.label).toBe("ci-bot");
    expect(body.rate_limit).toBe(120);

    const row = ctx.app.db
      .prepare("SELECT key_hash, label, rate_limit FROM api_keys WHERE key_hash = ?")
      .get(body.key_hash) as { key_hash: string; label: string; rate_limit: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.label).toBe("ci-bot");
    expect(row?.rate_limit).toBe(120);
  });

  it("Idempotency-Key replay returns the same minted key, not a new one", async () => {
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "keys-replay-1" };
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers,
      payload: {},
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers,
      payload: {},
    });
    expect(first.json()).toEqual(second.json());

    const count = (ctx.app.db.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number })
      .n;
    expect(count).toBe(2); // the fixture key from setup() + the one minted above
  });
});
