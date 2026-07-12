#!/usr/bin/env node
/**
 * Sets up the ACP (anyone-can-pay) fee-collection cell pool that
 * `chain`'s `applyServiceFee` tops up on every fee-liable anchor — see
 * `docs/DEPLOY.md`'s "Fee-cell setup" section for the full runbook.
 *
 * Two modes:
 *
 *   --print-acp-address <owner-address> --network <testnet|mainnet|devnet>
 *     Derives and prints the ACP fee-collection address for that owner
 *     address on that network. Sends nothing, reads no private key.
 *
 *   --network <net> --key-file <path> [--count 3] [--capacity-ckb 100] [--fee-address <addr>]
 *     Funds a pool of `count` fresh ACP fee-collection cells at
 *     `capacity-ckb` CKB each, paid from the wallet in --key-file, at the
 *     network's configured `VERICELL_FEE_ADDRESS_<NETWORK>` (or
 *     --fee-address to override it for this run).
 *
 * The funding/payer key is read from a file and only ever handed to a
 * `Signer` — never logged, echoed, or persisted anywhere by this script.
 */
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { buildCreateFeeCellsTx, ccc, feeLockFor, makeClient } from "chain";
import { type Network } from "core";

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

async function deriveAcpAddress(
  client: ccc.Client,
  ownerAddress: string,
): Promise<{ script: ccc.Script; address: string }> {
  const owner = await ccc.Address.fromString(ownerAddress, client);
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  const script = ccc.Script.from({
    codeHash: acpInfo.codeHash,
    hashType: acpInfo.hashType,
    args: owner.script.args,
  });
  return { script, address: new ccc.Address(script, client.addressPrefix).toString() };
}

async function printAcpAddress(ownerAddress: string, network: Network): Promise<void> {
  const client = makeClient(network);
  const { address } = await deriveAcpAddress(client, ownerAddress);
  console.log(address);
}

async function createPool(opts: {
  network: Network;
  keyFile: string;
  count: number;
  capacityCkb: number;
  feeAddress?: string;
}): Promise<void> {
  const client = makeClient(opts.network);
  const payer = new ccc.SignerCkbPrivateKey(client, readPrivateKeyHex(opts.keyFile));
  await payer.connect();
  const payerLock = (await payer.getRecommendedAddressObj()).script;

  // An explicit --fee-address overrides (only for this process) the
  // VERICELL_FEE_ADDRESS_<NETWORK> env var that `feeLockFor` reads, so the
  // exact same derivation code path is used either way.
  if (opts.feeAddress) {
    process.env[`VERICELL_FEE_ADDRESS_${opts.network.toUpperCase()}`] = opts.feeAddress;
  }
  const feeLock = await feeLockFor(client, opts.network);
  if (!feeLock) {
    throw new Error(
      `No fee address configured: pass --fee-address or set VERICELL_FEE_ADDRESS_${opts.network.toUpperCase()}.`,
    );
  }
  const feeAddressString = new ccc.Address(feeLock, client.addressPrefix).toString();

  const capacityPerCellShannons = BigInt(opts.capacityCkb) * 100_000_000n;
  const tx = await buildCreateFeeCellsTx({
    client,
    payerLock,
    feeLock,
    count: opts.count,
    capacityPerCellShannons,
  });

  const txHash = await payer.sendTransaction(tx);
  console.log(
    `Broadcasting ${opts.count} fee-collection cell(s) of ${opts.capacityCkb} CKB each on ${opts.network}...`,
  );
  console.log(`ACP fee address: ${feeAddressString}`);
  console.log(`tx: ${txHash}`);
  await client.waitTransaction(txHash);
  console.log("Confirmed.");
}

const program = new Command();
program
  .name("create-fee-cells")
  .description("Set up (or inspect) the ACP fee-collection cell pool for the service fee.")
  .option(
    "--print-acp-address <address>",
    "print the derived ACP address for this owner address and exit",
  )
  .option("--network <network>", "testnet, mainnet, or devnet", "testnet")
  .option("--key-file <path>", "file containing the hex-encoded payer private key")
  .option("--fee-address <address>", "override VERICELL_FEE_ADDRESS_<NETWORK> for this run")
  .option("--count <n>", "number of pool cells to create", "3")
  .option("--capacity-ckb <n>", "capacity per pool cell, in CKB", "100")
  .action(async (opts: Record<string, string>) => {
    const network = parseNetwork(opts.network!);

    if (opts.printAcpAddress) {
      await printAcpAddress(opts.printAcpAddress, network);
      return;
    }

    if (!opts.keyFile) {
      throw new Error("--key-file is required unless --print-acp-address is given");
    }
    await createPool({
      network,
      keyFile: opts.keyFile,
      count: Number.parseInt(opts.count!, 10),
      capacityCkb: Number.parseInt(opts.capacityCkb!, 10),
      feeAddress: opts.feeAddress,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`create-fee-cells: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
