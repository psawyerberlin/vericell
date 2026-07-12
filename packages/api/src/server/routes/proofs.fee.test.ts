import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ccc, FakeClient, type ProofResult } from "chain";
import { openDb } from "../../db/open.js";
import { hashApiKey } from "../auth.js";
import { buildServer, type TypedApp } from "../build.js";

const PAYER_PRIVATE_KEY = "0x" + "ab".repeat(32);
const FEE_OWNER_PRIVATE_KEY = "0x" + "ef".repeat(32);
const API_KEY = "vk_test_fee0123456789abcdef0123456789ab";
const API_KEY_HASH = hashApiKey(API_KEY);
const FEE_ENV_VAR = "VERICELL_FEE_ADDRESS_DEVNET";

const NULL_PROOF: ProofResult = {
  manifest: null,
  live: null,
  blockNumber: null,
  blockTime: null,
  ownerAddress: null,
};

/** A manifest draft with enough files that its proof cell's capacity clears the 300 CKB fee-waiver threshold. */
const LARGE_MANIFEST_DRAFT = {
  title: "Fee-paying project",
  files: Array.from({ length: 150 }, (_, i) => ({
    p: `src/some/fairly/long/path/to/file-number-${i}.ts`,
    h: i.toString(16).padStart(2, "0").repeat(32),
  })),
};

interface Ctx {
  app: TypedApp;
  client: FakeClient;
  payerLock: ccc.Script;
  payerSigner: ccc.SignerCkbPrivateKey;
  feeOwnerAddress: string;
  acpLock: ccc.Script;
}

async function setup(): Promise<Ctx> {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
  ).run(API_KEY_HASH, "test", new Date().toISOString(), 1000);

  const client = new FakeClient();

  const payerSigner = new ccc.SignerCkbPrivateKey(client, PAYER_PRIVATE_KEY);
  await payerSigner.connect();
  const payerLock = (await payerSigner.getRecommendedAddressObj()).script;
  client.addLiveCell({
    outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
    cellOutput: { capacity: ccc.fixedPointFrom(100_000), lock: payerLock },
    outputData: "0x",
  });

  const feeOwnerSigner = new ccc.SignerCkbPrivateKey(client, FEE_OWNER_PRIVATE_KEY);
  await feeOwnerSigner.connect();
  const feeOwnerLock = (await feeOwnerSigner.getRecommendedAddressObj()).script;
  const feeOwnerAddress = await feeOwnerSigner.getRecommendedAddress();

  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  const acpLock = ccc.Script.from({
    codeHash: acpInfo.codeHash,
    hashType: acpInfo.hashType,
    args: feeOwnerLock.args,
  });
  client.addLiveCell({
    outPoint: { txHash: "0x" + "22".repeat(32), index: 0 },
    cellOutput: { capacity: ccc.fixedPointFrom(100), lock: acpLock },
    outputData: "0x",
  });

  const app = buildServer({
    db,
    network: "devnet",
    chainClient: () => client,
    fetchProof: async () => NULL_PROOF,
    rateLimit: { max: 1000, timeWindow: "1 minute" },
  });

  return { app, client, payerLock, payerSigner, feeOwnerAddress, acpLock };
}

describe("service fee wired into /proofs/prepare and /proofs/submit", () => {
  let ctx: Ctx;
  const originalEnv = process.env[FEE_ENV_VAR];

  beforeEach(async () => {
    delete process.env[FEE_ENV_VAR];
    ctx = await setup();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[FEE_ENV_VAR];
    else process.env[FEE_ENV_VAR] = originalEnv;
  });

  it("prepare reports fee_configured=false and service_fee=0 when no fee address is configured", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: LARGE_MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cost.fee_configured).toBe(false);
    expect(body.cost.service_fee).toBe("0");
    // No fee configured -> no extra ACP leg, just the proof cell (+ payer change, if any).
    expect(
      body.tx.outputs.every((o: { lock: { args: string } }) => o.lock.args !== ctx.acpLock.args),
    ).toBe(true);
  });

  // The exact waiver boundary (< 300 CKB -> 0, >= 300 CKB -> 1%) is proven
  // precisely by core's own computeFee tests (packages/core/src/fee.test.ts)
  // against raw capacity numbers; this suite only proves the API wiring
  // (fee_configured propagation, the ACP leg's shape, submit-time
  // enforcement) — this fixture's lock + Type ID overhead alone already
  // exceeds 300 CKB for any manifest, so a naturally "waived" manifest
  // isn't reproducible through this harness without a contrived payload.

  it("prepare charges 1% and includes a matching ACP top-up leg once a fee address is configured and capacity clears the waiver", async () => {
    process.env[FEE_ENV_VAR] = ctx.feeOwnerAddress;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: LARGE_MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const capacity = BigInt(body.capacity);
    expect(capacity).toBeGreaterThanOrEqual(300n * 100_000_000n);
    const expectedFee = capacity / 100n;
    expect(body.cost.fee_configured).toBe(true);
    expect(body.cost.service_fee).toBe(expectedFee.toString());
    expect(BigInt(body.cost.locked_capacity)).toBe(capacity);

    const feeOutputs = body.tx.outputs.filter(
      (o: { lock: { args: string } }) => o.lock.args === ctx.acpLock.args,
    );
    expect(feeOutputs).toHaveLength(1);
    expect(BigInt(feeOutputs[0].capacity) - ccc.fixedPointFrom(100)).toBe(expectedFee);
  });

  it("submit rejects a transaction whose fee leg was stripped before signing, when a fee is due", async () => {
    // Build a large-capacity tx the same way `chain` would, but with the fee
    // address unconfigured, so it never gets the ACP top-up leg — simulating
    // a client that prepared, then stripped the fee leg before signing.
    delete process.env[FEE_ENV_VAR];
    const strippedRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: LARGE_MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    process.env[FEE_ENV_VAR] = ctx.feeOwnerAddress;
    expect(strippedRes.statusCode).toBe(200);

    const strippedTx = ccc.Transaction.from(strippedRes.json().tx as ccc.TransactionLike);
    const signedTx = await ctx.payerSigner.signTransaction(strippedTx);

    const submitRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: JSON.parse(ccc.stringify(signedTx)) },
    });

    expect(submitRes.statusCode).toBe(402);
    expect(submitRes.headers["content-type"]).toContain("application/problem+json");
    expect(submitRes.json().detail).toMatch(/Service fee not paid/);
  });

  it("submit accepts a transaction that correctly pays the due fee", async () => {
    process.env[FEE_ENV_VAR] = ctx.feeOwnerAddress;
    const prepareRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: LARGE_MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(prepareRes.statusCode).toBe(200);

    const tx = ccc.Transaction.from(prepareRes.json().tx as ccc.TransactionLike);
    const signedTx = await ctx.payerSigner.signTransaction(tx);

    const submitRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: JSON.parse(ccc.stringify(signedTx)) },
    });
    expect(submitRes.statusCode).toBe(202);
    expect(submitRes.json().tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
