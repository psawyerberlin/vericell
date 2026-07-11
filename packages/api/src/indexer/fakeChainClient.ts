import { ccc } from "@ckb-ccc/ccc";
import type { IndexerClient } from "./types.js";

const ZERO_HASH = ("0x" + "00".repeat(32)) as ccc.Hex;
const FAKE_TYPE_ID_CODE_HASH = ("0x" + "11".repeat(32)) as ccc.Hex;

/** Cheap deterministic-looking 32-byte hex "hash" — not a real hash function, just unique per seed. */
function fakeHash(seed: string): ccc.Hex {
  let acc = 0n;
  for (const byte of new TextEncoder().encode(seed)) {
    acc = (acc * 131n + BigInt(byte)) % 2n ** 256n;
  }
  return ("0x" + acc.toString(16).padStart(64, "0")) as ccc.Hex;
}

function makeHeader(params: {
  number: bigint;
  hash: ccc.Hex;
  parentHash: ccc.Hex;
  timestamp: bigint;
}): ccc.ClientBlockHeader {
  return ccc.ClientBlockHeader.from({
    compactTarget: 0,
    dao: { c: 0, ar: 0, s: 0, u: 0 },
    epoch: [0, 0, 1],
    extraHash: ZERO_HASH,
    hash: params.hash,
    nonce: 0,
    number: params.number,
    parentHash: params.parentHash,
    proposalsHash: ZERO_HASH,
    timestamp: params.timestamp,
    transactionsRoot: ZERO_HASH,
    version: 0,
  });
}

/**
 * A minimal in-memory `IndexerClient` for unit tests (reorgs, cursor
 * resume) — not a full `ccc.Client`, just the narrow surface the indexer
 * uses. Mirrors the spirit of `chain`'s `FakeClient` (not exported from
 * that package's public barrel either — see its DECISIONS.md entry).
 */
export class FakeChainClient implements IndexerClient {
  readonly addressPrefix = "ckt";
  private readonly typeIdInfo = ccc.ScriptInfo.from({
    codeHash: FAKE_TYPE_ID_CODE_HASH,
    hashType: "type",
    cellDeps: [],
  });
  private blocks: ccc.ClientBlock[];

  constructor() {
    const header = makeHeader({
      number: 0n,
      hash: fakeHash("genesis"),
      parentHash: ZERO_HASH,
      timestamp: 0n,
    });
    this.blocks = [ccc.ClientBlock.from({ header, proposals: [], transactions: [], uncles: [] })];
  }

  get typeIdScriptInfo(): ccc.ScriptInfo {
    return this.typeIdInfo;
  }

  /** Append a new block containing `txLikes` on top of the current tip. */
  addBlock(
    txLikes: ccc.TransactionLike[],
    timestampMs = BigInt(this.blocks.length) * 1000n,
  ): ccc.ClientBlock {
    const parent = this.blocks[this.blocks.length - 1]!;
    const number = parent.header.number + 1n;
    const transactions = txLikes.map((t) => ccc.Transaction.from(t));
    const hash = fakeHash(
      `block:${number}:${transactions.map((t) => t.hash()).join(",")}:${this.blocks.length}:${Math.random()}`,
    );
    const header = makeHeader({
      number,
      hash,
      parentHash: parent.header.hash,
      timestamp: timestampMs,
    });
    const block = ccc.ClientBlock.from({ header, proposals: [], transactions, uncles: [] });
    this.blocks.push(block);
    return block;
  }

  /** Simulate a reorg: discard every block after `keepNumber` (exclusive of it staying). */
  reorgAfter(keepNumber: bigint): void {
    this.blocks = this.blocks.filter((b) => b.header.number <= keepNumber);
  }

  async getTip(): Promise<ccc.Num> {
    return this.blocks[this.blocks.length - 1]!.header.number;
  }

  async getBlockByNumber(blockNumber: ccc.NumLike): Promise<ccc.ClientBlock | undefined> {
    const n = ccc.numFrom(blockNumber);
    return this.blocks.find((b) => b.header.number === n);
  }

  async getKnownScript(script: ccc.KnownScript): Promise<ccc.ScriptInfo> {
    if (script !== ccc.KnownScript.TypeId) {
      throw new Error(`FakeChainClient: unsupported KnownScript ${script}`);
    }
    return this.typeIdInfo;
  }
}
