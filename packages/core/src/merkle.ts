import { concatBytes, hexToBytes, sha256Hex } from "./hash.js";
import type { FileEntry } from "./projectHash.js";

export type MerkleProofPosition = "left" | "right";

export interface MerkleProofStep {
  hash: string;
  /** Side the sibling sits on relative to the node being combined at this level. */
  position: MerkleProofPosition;
}

function sortedLeafHashes(entries: FileEntry[]): string[] {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => e.hash);
}

async function combine(left: string, right: string): Promise<string> {
  return sha256Hex(concatBytes(hexToBytes(left), hexToBytes(right)));
}

/**
 * Binary Merkle tree over the sorted leaf hashes (odd leaf duplicated at each level).
 */
export async function merkleRoot(entries: FileEntry[]): Promise<string> {
  let level = sortedLeafHashes(entries);
  if (level.length === 0) {
    throw new Error("merkleRoot: entries must not be empty");
  }
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = (level[i + 1] ?? level[i]) as string;
      next.push(await combine(left, right));
    }
    level = next;
  }
  return level[0] as string;
}

/**
 * Merkle proof (sibling path from leaf to root) for the file at `path`.
 */
export async function merkleProof(entries: FileEntry[], path: string): Promise<MerkleProofStep[]> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let index = sorted.findIndex((e) => e.path === path);
  if (index === -1) {
    throw new Error(`merkleProof: no entry with path ${path}`);
  }

  let level = sorted.map((e) => e.hash);
  const steps: MerkleProofStep[] = [];

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = (level[i + 1] ?? level[i]) as string;
      next.push(await combine(left, right));

      if (i === index || i + 1 === index) {
        const isLeft = index === i;
        const siblingHash = isLeft ? right : left;
        steps.push({ hash: siblingHash, position: isLeft ? "right" : "left" });
      }
    }
    index = Math.floor(index / 2);
    level = next;
  }

  return steps;
}

/**
 * Recompute the root from a leaf hash and its proof, and compare to `root`.
 */
export async function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProofStep[],
  root: string,
): Promise<boolean> {
  let current = leafHash;
  for (const step of proof) {
    current =
      step.position === "left"
        ? await combine(step.hash, current)
        : await combine(current, step.hash);
  }
  return current === root;
}
