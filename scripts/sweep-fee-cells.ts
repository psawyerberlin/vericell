#!/usr/bin/env node
/**
 * Consolidates accumulated service-fee capacity to the fee owner's own
 * wallet address — see `docs/DEPLOY.md`'s "Maintenance" section.
 *
 * Every fee-collection cell above `--reserve-ckb` (default: matching the
 * pool's seed capacity, 100 CKB) is swept: the excess goes to the owner,
 * and each swept cell is re-created at exactly `--reserve-ckb` so fee
 * collection (`applyServiceFee`'s top-ups) keeps working afterward.
 *
 * Spending an ACP-locked cell for anything less than its full capacity is
 * a *decrease* under the ACP lock's own rule (RFC 0026), which requires a
 * real signature from the fee address's own key — read from a file here
 * and only ever handed to a `Signer`, never logged, echoed, or persisted.
 */
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { buildSweepFeeCellsTx, ccc, feeLockFor, makeClient } from "chain";
import { type Network } from "core";

const DEFAULT_RESERVE_CKB = 100;

function readPrivateKeyHex(path: string): string {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error(`key file "${path}" is empty`);
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function parseNetwork(value: string): Network {
  if (value !== "testnet" && value !== "mainnet" && value !== "devnet") {
    throw new Error(`--network must be testnet, mainnet, or devnet (got "${value}")`);
  }
  return value;
}

async function sweep(opts: {
  network: Network;
  keyFile: string;
  reserveCkb: number;
}): Promise<void> {
  const client = makeClient(opts.network);
  const owner = new ccc.SignerCkbPrivateKey(client, readPrivateKeyHex(opts.keyFile));
  await owner.connect();
  const ownerLock = (await owner.getRecommendedAddressObj()).script;

  const feeLock = await feeLockFor(client, opts.network);
  if (!feeLock) {
    throw new Error(
      `No fee address configured for ${opts.network} (VERICELL_FEE_ADDRESS_${opts.network.toUpperCase()}).`,
    );
  }
  if (feeLock.args !== ownerLock.args) {
    throw new Error(
      "The supplied key does not match the configured fee address's owner key " +
        "(blake160 args mismatch) — sweeping would build a transaction this key cannot sign.",
    );
  }

  const reserveCapacityShannons = BigInt(opts.reserveCkb) * 100_000_000n;
  const result = await buildSweepFeeCellsTx({
    client,
    feeLock,
    ownerLock,
    reserveCapacityShannons,
  });

  if (!result.tx) {
    console.log(`Nothing to sweep: no fee-collection cell holds more than ${opts.reserveCkb} CKB.`);
    return;
  }

  console.log(
    `Sweeping ${result.cellsSwept} cell(s), ${result.totalSwept} shannons total, ` +
      `to ${await owner.getRecommendedAddress()}...`,
  );
  const signed = await owner.signTransaction(result.tx);
  const txHash = await client.sendTransaction(signed);
  console.log(`tx: ${txHash}`);
  await client.waitTransaction(txHash);
  console.log("Confirmed.");
}

const program = new Command();
program
  .name("sweep-fee-cells")
  .description("Consolidate accumulated service-fee capacity to the fee owner's wallet.")
  .requiredOption("--key-file <path>", "file containing the fee owner's hex-encoded private key")
  .option("--network <network>", "testnet, mainnet, or devnet", "testnet")
  .option(
    "--reserve-ckb <n>",
    "capacity to leave behind in each swept cell, in CKB",
    String(DEFAULT_RESERVE_CKB),
  )
  .action(async (opts: Record<string, string>) => {
    await sweep({
      network: parseNetwork(opts.network!),
      keyFile: opts.keyFile!,
      reserveCkb: Number.parseInt(opts.reserveCkb!, 10),
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`sweep-fee-cells: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
