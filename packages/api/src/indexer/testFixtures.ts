import { ccc } from "@ckb-ccc/ccc";
import { encodeManifest, projectHash, merkleRoot, type Manifest } from "core";

export const TEST_LOCK: ccc.ScriptLike = {
  codeHash: ("0x" + "22".repeat(32)) as ccc.Hex,
  hashType: "type",
  args: "0x00",
};

export async function manifestBytesFor(title: string, extra?: Partial<Manifest>): Promise<ccc.Hex> {
  const entries = [{ path: "README.md", hash: "a".repeat(64) }];
  const manifest: Manifest = {
    app: "vericell",
    v: 1,
    title,
    created: new Date().toISOString(),
    project_sha256: await projectHash(entries),
    merkle_root: await merkleRoot(entries),
    count: entries.length,
    ...extra,
  };
  return ccc.hexFrom(encodeManifest(manifest));
}

/** Anchor tx: one VeriCell output, optionally consuming a previous version's cell. */
export function anchorTx(dataHex: ccc.Hex, prevOutPoint?: ccc.OutPointLike): ccc.Transaction {
  return ccc.Transaction.from({
    inputs: prevOutPoint ? [{ previousOutput: prevOutPoint }] : [],
    outputs: [{ capacity: 10_000_000_000n, lock: TEST_LOCK }],
    outputsData: [dataHex],
  });
}

/** Withdraw tx: consumes a live proof cell with no VeriCell successor output. */
export function withdrawTx(prevOutPoint: ccc.OutPointLike): ccc.Transaction {
  return ccc.Transaction.from({
    inputs: [{ previousOutput: prevOutPoint }],
    outputs: [{ capacity: 9_999_000_000n, lock: TEST_LOCK }],
    outputsData: ["0x"],
  });
}
