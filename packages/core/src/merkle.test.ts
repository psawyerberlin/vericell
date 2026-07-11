import { describe, expect, it } from "vitest";
import { merkleProof, merkleRoot, verifyMerkleProof } from "./merkle.js";
import type { FileEntry } from "./projectHash.js";

// Leaf hashes are sha256("leaf0") .. sha256("leaf6"), independently computed
// with Node's `crypto` module. Paths are single digits so lexicographic sort
// order equals numeric order, matching the order these vectors were built in.
const LEAF_HASHES = [
  "4d5a9584d985e8fb44015a8affa9b76f1ff16f65e61df7156d8e8159e1448978",
  "d103cfb5e499c566904787533afbdec56f95492d67fc00e2c0d0161ba99653f1",
  "5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a",
  "f2764fd79fdab5132fc349ba555c9c56ff0c935c889c17ebe3d61315d780934e",
  "565fb0e0cefe32cf4000e4a67ddec8820111a733aa8ba010d242a5fe477e04c4",
  "415eb888edf1abee0e8a2206505a8e8cd87647f77abee7b7fa0abb4be4528ebc",
  "a46b687d964dea9d93e55b6339615a6b9342cceb2e7690283143ce0c90f941d0",
];

function entriesFor(n: number): FileEntry[] {
  return LEAF_HASHES.slice(0, n).map((hash, i) => ({ path: `leaf${i}`, hash }));
}

describe("merkleRoot", () => {
  it("matches the hand-computed 4-leaf vector", async () => {
    expect(await merkleRoot(entriesFor(4))).toBe(
      "8910150e02a7fe57232749c31f7cfd48a8439011e34227c6b7e3eb7d98440ee6",
    );
  });

  it("matches the hand-computed 5-leaf vector (odd leaf duplicated)", async () => {
    expect(await merkleRoot(entriesFor(5))).toBe(
      "a8f85ed52b9f9a8cd7d8239cd6a70dc6587d46cc20d4f22b62a8bf262be0ab07",
    );
  });

  it("rejects an empty entry list", async () => {
    await expect(merkleRoot([])).rejects.toThrow();
  });
});

describe("merkleProof / verifyMerkleProof", () => {
  const SEVEN_LEAF_ROOT = "588bbad26b802c9c7d996dee8ac4afffbca2dc52cbf1a7f1bbf3404c59b98b85";

  it("matches the hand-computed 7-leaf root", async () => {
    expect(await merkleRoot(entriesFor(7))).toBe(SEVEN_LEAF_ROOT);
  });

  it("produces a valid proof for every leaf of the 7-leaf tree", async () => {
    const entries = entriesFor(7);
    for (const entry of entries) {
      const proof = await merkleProof(entries, entry.path);
      expect(await verifyMerkleProof(entry.hash, proof, SEVEN_LEAF_ROOT)).toBe(true);
    }
  });

  it("fails verification against a tampered leaf hash", async () => {
    const entries = entriesFor(7);
    const proof = await merkleProof(entries, "leaf0");
    expect(await verifyMerkleProof(LEAF_HASHES[1] as string, proof, SEVEN_LEAF_ROOT)).toBe(false);
  });

  it("throws for a path not present in the entries", async () => {
    const entries = entriesFor(4);
    await expect(merkleProof(entries, "does-not-exist")).rejects.toThrow();
  });
});
