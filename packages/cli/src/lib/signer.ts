import { readFileSync } from "node:fs";
import { ccc } from "chain";

/**
 * Reads a hex-encoded CCC private key from a file (one key, optionally
 * `0x`-prefixed, surrounding whitespace ignored). Never logged or echoed —
 * only ever handed straight to a `Signer`.
 */
function readPrivateKeyHex(path: string): string {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    throw new Error(`signer key file "${path}" is empty`);
  }
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

/** Loads and connects a local non-custodial signer from a key file — never touches the API or logs the key. */
export async function loadSigner(
  client: ccc.Client,
  keyFilePath: string,
): Promise<ccc.SignerCkbPrivateKey> {
  const signer = new ccc.SignerCkbPrivateKey(client, readPrivateKeyHex(keyFilePath));
  await signer.connect();
  return signer;
}
