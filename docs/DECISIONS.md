# Decisions

Record here any choice not already covered by `TECHNICAL.md` or `ClaudeCodeInstruction.md`, in the order made.

## Phase 1 — packages/core

- **Merkle leaves.** The tree is built directly over the per-file SHA-256 hashes (sorted by path), not over a re-hash of `path\nhash\n`. TECHNICAL.md §3 says "binary Merkle tree over the sorted leaf hashes," which reads most naturally as the file hashes themselves; `project_sha256` already covers path+hash binding.
- **Merkle proof shape.** `merkleProof` returns `{ hash, position: "left" | "right" }[]`, sibling hashes ordered leaf→root, `position` meaning which side the sibling sits on. Not specified in TECHNICAL.md; chosen as the simplest shape that lets `verifyMerkleProof` recompute the root without extra lookups.
- **`sha256Hex`/Merkle/`projectHash` are async.** They use `crypto.subtle.digest`, which is inherently Promise-based in the Web Crypto API: forcing sync would mean a non-Web-Crypto fallback, which the phase brief rules out ("use the Web Crypto API").
- **`manifest.created` validation.** Required to be RFC 3339 / ISO-8601 with an explicit offset (zod `.datetime({ offset: true })`), matching the `Z`-suffixed example in TECHNICAL.md §3.
- **`estimateCellCost`.** Computes `full`/`compact` from the *actual* `encodeManifest` byte length (+61 CKB overhead) rather than the approximate `90 + 110/file` formula in TECHNICAL.md §3 — that formula is explicitly a ballpark ("≈"), and the real encoded size is available and exact.
- **`network.ts` invalid env value.** An unrecognized `VERICELL_NETWORK`/`VITE_VERICELL_NETWORK` value falls back to the `testnet` default rather than throwing, so a typo in deployment config fails safe (never silently defaults to `mainnet`).
