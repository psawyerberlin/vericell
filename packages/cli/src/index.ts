#!/usr/bin/env node
import { Command } from "commander";
import { runAnchor, type AnchorOptions } from "./commands/anchor.js";
import { runHash, type HashOptions } from "./commands/hash.js";
import { runStatus, type StatusOptions } from "./commands/status.js";
import { runVerify, type VerifyOptions } from "./commands/verify.js";
import { runWithdraw, type WithdrawOptions } from "./commands/withdraw.js";
import { ApiRequestError } from "./lib/apiClient.js";
import { CliError } from "./lib/cliError.js";

const program = new Command();
program
  .name("vericell")
  .description(
    "Prove authorship, integrity and time of a project by anchoring its SHA-256 manifest on CKB.",
  );

/** Prints an error uniformly (text or `--json`) and returns the process exit code for it. */
function reportError(err: unknown, json: boolean | undefined): number {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`error: ${message}`);
  }
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof ApiRequestError) return 1;
  return 1;
}

program
  .command("hash")
  .description("Hash files/directories and build a manifest draft (TECHNICAL.md §3)")
  .argument("<paths...>", "files or directories to hash")
  .option("--out <file>", "write the manifest JSON to this file")
  .option("--compact", "omit the files list from the written manifest (Merkle-root mode)")
  .option("--title <title>", "manifest title (defaults to the first path's basename)")
  .option("--source <url>", "manifest source URL")
  .option("--json", "machine-readable output")
  .action(async (paths: string[], opts: HashOptions) => {
    try {
      await runHash(paths, opts);
    } catch (err) {
      process.exitCode = reportError(err, opts.json);
    }
  });

program
  .command("anchor")
  .description("Anchor a manifest on-chain via the VeriCell API (TECHNICAL.md §7.5)")
  .argument("<manifest>", "path to a manifest.json produced by `vericell hash`")
  .requiredOption("--api <url>", "VeriCell API base URL, e.g. https://api.example.com/api/v1")
  .requiredOption("--key <key>", "VeriCell API key")
  .requiredOption("--mode <mode>", "non-custodial or custodial")
  .option(
    "--signer-key-file <file>",
    "local CCC private key file (required for --mode non-custodial)",
  )
  .option("--prev <tx>", "previous version's tx hash, to anchor a new version")
  .option("--json", "machine-readable output")
  .action(async (manifestPath: string, opts: AnchorOptions) => {
    try {
      await runAnchor(manifestPath, opts);
    } catch (err) {
      process.exitCode = reportError(err, opts.json);
    }
  });

program
  .command("verify")
  .description("Hash a local file and check it against the VeriCell index")
  .argument("<file>", "file to verify")
  .requiredOption("--api <url>", "VeriCell API base URL")
  .option("--json", "machine-readable output")
  .action(async (filePath: string, opts: VerifyOptions) => {
    try {
      const foundAndLive = await runVerify(filePath, opts);
      process.exitCode = foundAndLive ? 0 : 1;
    } catch (err) {
      process.exitCode = reportError(err, opts.json);
    }
  });

program
  .command("status")
  .description("Show a project's on-chain status and version history")
  .argument("<unid>", "project UNID")
  .requiredOption("--api <url>", "VeriCell API base URL")
  .option("--json", "machine-readable output")
  .action(async (unid: string, opts: StatusOptions) => {
    try {
      await runStatus(unid, opts);
    } catch (err) {
      process.exitCode = reportError(err, opts.json);
    }
  });

program
  .command("withdraw")
  .description("Withdraw a project's live proof cell (consume without a successor)")
  .argument("<unid>", "project UNID")
  .requiredOption("--api <url>", "VeriCell API base URL")
  .requiredOption("--key <key>", "VeriCell API key")
  .option("--mode <mode>", "non-custodial or custodial (default: custodial)")
  .option(
    "--signer-key-file <file>",
    "local CCC private key file (required for --mode non-custodial)",
  )
  .option("--json", "machine-readable output")
  .action(async (unid: string, opts: WithdrawOptions) => {
    try {
      await runWithdraw(unid, opts);
    } catch (err) {
      process.exitCode = reportError(err, opts.json);
    }
  });

await program.parseAsync(process.argv);
