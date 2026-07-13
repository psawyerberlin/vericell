import {
  buildAnchorTx,
  buildAnchorTxWithTypeId,
  buildWithdrawTx,
  ccc,
  verifyServiceFeePaid,
  type ProofResult,
} from "chain";
import {
  costBreakdown,
  decodeManifest,
  type CostBreakdown,
  type Manifest,
  type Network,
} from "core";
import { requireApiKey } from "../auth.js";
import {
  BadGatewayError,
  ConflictError,
  NotFoundError,
  PaymentRequiredError,
  ProblemError,
} from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { buildFullManifest, manifestBytes } from "../manifestDraft.js";
import { txFromJson, txToJson } from "../txJson.js";
import { PrepareBodySchema, SubmitBodySchema, type ManifestDraft } from "../writeSchemas.js";
import { insertPendingVersion, markProjectWithdrawnPending } from "../writeQueries.js";
import type { TypedApp } from "../build.js";

async function resolvePayerLock(
  client: ccc.Client,
  payer: { lock?: ccc.ScriptLike; address?: string },
): Promise<ccc.ScriptLike> {
  if (payer.lock) return payer.lock;
  // PayerSchema's `.refine` guarantees at least one of the two is set.
  const address = await ccc.Address.fromString(payer.address!, client);
  return address.script;
}

function ownerAddressOf(lock: ccc.ScriptLike, addressPrefix: string): string {
  return new ccc.Address(ccc.Script.from(lock), addressPrefix).toString();
}

/**
 * Resolves a live proof cell by its creating tx hash: validates it's still
 * live and returns both the chain-derived proof and its actual on-chain
 * cell. Shared by `prepare`'s "new version" (`prev_tx_hash`) and "withdraw"
 * (`withdraw_tx_hash`) branches — both need the same live/not-found/dead
 * checks before building against it.
 */
async function resolveLiveProofCell(
  app: TypedApp,
  client: ccc.Client,
  txHash: string,
): Promise<{ proof: ProofResult; cell: ccc.Cell }> {
  const proof = await app.fetchProofFromChain(txHash);
  if (!proof.manifest) {
    throw new NotFoundError(`No proof found for tx hash "${txHash}"`);
  }
  if (proof.live !== true) {
    throw new ConflictError(
      `tx hash "${txHash}" is not a live proof cell (already superseded or withdrawn)`,
    );
  }
  const cell = await client.getCell({ txHash, index: 0 });
  if (!cell) {
    throw new NotFoundError(`Could not locate the live cell for "${txHash}"`);
  }
  return { proof, cell };
}

async function resolvePrevVersion(
  app: TypedApp,
  client: ccc.Client,
  prevTxHash: string,
): Promise<{ genesis: string; prevOutPoint: ccc.OutPointLike; prevTypeScript?: ccc.ScriptLike }> {
  const { proof, cell } = await resolveLiveProofCell(app, client, prevTxHash);
  return {
    genesis: proof.manifest!.genesis ?? prevTxHash,
    prevOutPoint: cell.outPoint,
    prevTypeScript: cell.cellOutput.type ?? undefined,
  };
}

async function buildAnchor(
  client: ccc.Client,
  lock: ccc.ScriptLike,
  bytes: Uint8Array,
  network: Network,
  prev?: { prevOutPoint: ccc.OutPointLike; prevTypeScript?: ccc.ScriptLike },
): Promise<ccc.Transaction> {
  if (prev?.prevTypeScript) {
    return (
      await buildAnchorTxWithTypeId({
        client,
        lock,
        manifestBytes: bytes,
        prevOutPoint: prev.prevOutPoint,
        prevTypeScript: prev.prevTypeScript,
        network,
      })
    ).tx;
  }
  if (prev) {
    return buildAnchorTx({
      client,
      lock,
      manifestBytes: bytes,
      prevOutPoint: prev.prevOutPoint,
      network,
    });
  }
  // Brand-new project: Type ID by default (TECHNICAL.md §5, "Production").
  return (await buildAnchorTxWithTypeId({ client, lock, manifestBytes: bytes, network })).tx;
}

interface CostBreakdownBody {
  locked_capacity: string;
  network_fee: string;
  service_fee: string;
  fee_configured: boolean;
}

/** Shared `/proofs/*` response field: what this anchor actually costs, mirrored by the CLI/web pre-confirm summary (`core.costBreakdown`). */
async function costBreakdownBody(
  client: ccc.Client,
  tx: ccc.Transaction,
  network: Network,
): Promise<CostBreakdownBody> {
  const capacity = tx.outputs[0]?.capacity ?? 0n;
  const cost: CostBreakdown = costBreakdown(capacity, network);
  const networkFee = await tx.getFee(client);
  return {
    locked_capacity: cost.lockedCapacityShannons.toString(),
    network_fee: networkFee.toString(),
    service_fee: cost.serviceFeeShannons.toString(),
    fee_configured: cost.feeConfigured,
  };
}

function deriveUnid(output0: ccc.CellOutput, manifest: Manifest, txHash: string): string {
  return output0.type ? output0.type.args : (manifest.genesis ?? txHash);
}

/** Same idea as {@link deriveUnid}, but for the cell being *consumed* (withdraw) rather than created. */
function deriveUnidFromCell(cell: ccc.Cell, manifest: Manifest): string {
  return cell.cellOutput.type
    ? cell.cellOutput.type.args
    : (manifest.genesis ?? cell.outPoint.txHash);
}

async function prepareWithdraw(
  app: TypedApp,
  client: ccc.Client,
  withdrawTxHash: string,
): Promise<{ status: number; body: unknown }> {
  const { cell } = await resolveLiveProofCell(app, client, withdrawTxHash);
  // Withdrawing creates no new proof cell, so it carries no service fee
  // (TECHNICAL.md §7.2-B) — buildWithdrawTx never touches the fee pool.
  const tx = await buildWithdrawTx({ client, lock: cell.cellOutput.lock, outPoint: cell.outPoint });
  return {
    status: 200,
    body: {
      tx: txToJson(tx),
      refund_capacity: tx.outputs[0]!.capacity.toString(),
    },
  };
}

/**
 * Submit-side counterpart of an anchor transaction (a brand-new project or a
 * new version): output 0 carries manifest bytes. Verifies the service fee
 * was paid, broadcasts, and records a `pending` version.
 */
async function submitAnchor(
  app: TypedApp,
  client: ccc.Client,
  tx: ccc.Transaction,
  output0: ccc.CellOutput,
  data0: ccc.HexLike,
): Promise<{ status: number; body: unknown }> {
  let manifest: Manifest;
  try {
    manifest = decodeManifest(ccc.bytesFrom(data0));
  } catch (err) {
    throw new ProblemError(
      400,
      "Bad Request",
      `Output 0 data is not a valid VeriCell manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const feeCheck = await verifyServiceFeePaid(client, tx, app.network);
  if (!feeCheck.ok) {
    throw new PaymentRequiredError(
      `Service fee not paid: this anchor's locked capacity requires ${feeCheck.due} shannons ` +
        `to the configured fee address, but the transaction only pays it ${feeCheck.paid} — ` +
        `the fee leg from /proofs/prepare must not be removed or altered before signing.`,
    );
  }

  let txHash: string;
  try {
    txHash = await client.sendTransaction(tx);
  } catch (err) {
    throw new BadGatewayError(
      `Broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const unid = deriveUnid(output0, manifest, txHash);
  insertPendingVersion(app.db, {
    txHash,
    unid,
    manifest,
    ownerAddress: ownerAddressOf(output0.lock, client.addressPrefix),
  });

  return { status: 202, body: { tx_hash: txHash, unid } };
}

/**
 * Submit-side counterpart of a withdraw transaction: no manifest output,
 * just a single input consuming the live proof cell. No service fee to
 * verify — withdrawing creates no new proof cell.
 */
async function submitWithdraw(
  app: TypedApp,
  client: ccc.Client,
  tx: ccc.Transaction,
): Promise<{ status: number; body: unknown }> {
  if (tx.inputs.length !== 1) {
    throw new ProblemError(
      400,
      "Bad Request",
      "A withdraw transaction must consume exactly one input (the live proof cell) and carry no manifest output.",
    );
  }
  const prevOutPoint = tx.inputs[0]!.previousOutput;
  const prevCell = await client.getCell(prevOutPoint);
  if (!prevCell) {
    throw new NotFoundError(
      `Could not locate the cell being withdrawn (${prevOutPoint.txHash}#${prevOutPoint.index})`,
    );
  }
  const prevProof = await app.fetchProofFromChain(prevOutPoint.txHash);
  if (!prevProof.manifest) {
    throw new ProblemError(
      400,
      "Bad Request",
      "The input being consumed is not a VeriCell proof cell.",
    );
  }

  let txHash: string;
  try {
    txHash = await client.sendTransaction(tx);
  } catch (err) {
    throw new BadGatewayError(
      `Broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const unid = deriveUnidFromCell(prevCell, prevProof.manifest);
  markProjectWithdrawnPending(app.db, unid);

  return {
    status: 202,
    body: {
      tx_hash: txHash,
      unid,
      refund_capacity: tx.outputs[0]?.capacity.toString() ?? "0",
    },
  };
}

export function registerProofRoutes(app: TypedApp): void {
  // Non-custodial: the API prepares, the client signs. Covers all three
  // transaction shapes — first anchor, new version (prev_tx_hash), and
  // withdraw (withdraw_tx_hash) — the client always signs and broadcasts
  // itself via /proofs/submit.

  app.post(
    "/proofs/prepare",
    {
      schema: {
        tags: ["proofs"],
        summary: "Build an unsigned anchor or withdraw transaction for the caller to sign locally",
        body: PrepareBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const client = app.getChainClient();

        if ("withdraw_tx_hash" in req.body) {
          return prepareWithdraw(app, client, req.body.withdraw_tx_hash);
        }

        const { manifest: draft, payer, prev_tx_hash } = req.body;
        const lock = await resolvePayerLock(client, payer);

        const prev = prev_tx_hash ? await resolvePrevVersion(app, client, prev_tx_hash) : undefined;
        const manifest = await buildFullManifest(
          draft as ManifestDraft,
          prev ? { genesis: prev.genesis, prev: prev_tx_hash } : undefined,
        );
        const bytes = manifestBytes(manifest);

        const tx = await buildAnchor(client, lock, bytes, app.network, prev);
        const capacity = tx.outputs[0]!.capacity;

        return {
          status: 200,
          body: {
            tx: txToJson(tx),
            capacity: capacity.toString(),
            project_sha256: manifest.project_sha256,
            manifest,
            cost: await costBreakdownBody(client, tx, app.network),
          },
        };
      });
    },
  );

  app.post(
    "/proofs/submit",
    {
      schema: {
        tags: ["proofs"],
        summary: "Broadcast a signed anchor or withdraw transaction",
        body: SubmitBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const tx = txFromJson(req.body.tx);
        const client = app.getChainClient();

        const output0 = tx.outputs[0];
        const data0 = tx.outputsData[0];
        // An anchor tx's output 0 always carries manifest bytes; a withdraw
        // tx is a plain capacity refund with no such output — this is the
        // same "does the data look like a manifest" signal the indexer
        // itself uses to detect VeriCell cells (indexer/detect.ts).
        if (!output0 || data0 === undefined || ccc.bytesFrom(data0).length === 0) {
          return submitWithdraw(app, client, tx);
        }

        return submitAnchor(app, client, tx, output0, data0);
      });
    },
  );
}
