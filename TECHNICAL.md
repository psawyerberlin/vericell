# VeriCell — Technical Documentation

Proof of authorship, integrity and time for any digital project, anchored in a live cell on Nervos CKB. Accessible through a web app **and** a REST API for automation (CI/CD, GitHub Actions, scripts).

> Note on naming: the hash algorithm is **SHA-256** (256-bit output of the SHA-2 family). "SHA254" in early notes refers to the same thing.

## 1. Problem statement

A SHA-256 hash published next to a download proves file integrity — but only as long as the web page itself is trusted and unchanged. It proves nothing about:

- **Time** — when the file first existed in that exact form
- **Author** — who published it (a hash has no owner)
- **Currency** — whether this is still the latest version, and where to find it

VeriCell solves all three by storing a hash **manifest** in a CKB cell:

| Property     | Provided by                                                        |
|--------------|--------------------------------------------------------------------|
| Integrity    | SHA-256 of every file + overall project hash + Merkle root          |
| Time         | Block header timestamp of the anchoring transaction (PoW-secured)   |
| Author       | The cell's lock script = the creator's wallet; only they can consume/update it |
| Currency     | Cell liveness: **live cell = current version**, consumed = superseded. The consuming transaction points to the successor. |
| Source       | `source` URL field in the manifest (immutable once anchored)        |

## 2. Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────────────┐
│  Web SPA (Vite)             │     │  Automation clients               │
│  · Web Crypto SHA-256       │     │  · CLI (vericell)                │
│  · CCC wallet (JoyID, …)    │     │  · GitHub Action / CI pipelines   │
│  · builds & signs txs       │     │  · any HTTP client                │
└──────────┬──────────────────┘     └──────────────┬───────────────────┘
           │ read: search/verify                   │ REST (API key)
           ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  VeriCell API service (Node/Fastify)                                │
│  · REST API  /api/v1  (OpenAPI 3.1)                                  │
│  · Indexer worker: follows the chain, parses manifests               │
│  · DB (SQLite → PostgreSQL): projects / versions / hashes            │
│  · optional signing wallet for custodial automation mode             │
└──────────┬───────────────────────────────────────────────────────────┘
           │ RPC (CKB node / public RPC)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Nervos CKB — proof cells: lock = owner, data = manifest             │
└──────────────────────────────────────────────────────────────────────┘
```

The chain is the source of truth. The database is **derived state** — anyone can rebuild it from the chain, so users never have to trust the VeriCell server. The web app can operate without the API (direct RPC + local index); the API adds global search and automation.

Package note: the CCC repository is `github.com/ckb-devrel/ccc`; the npm package is **`@ckb-ccc/ccc`**.

## 3. On-chain manifest (cell data)

```json
{
  "app": "vericell",
  "v": 1,
  "title": "EasyTransfer v1.4.0",
  "created": "2026-07-10T12:00:00Z",
  "source": "https://github.com/you/easytransfer",
  "project_sha256": "…64 hex…",
  "merkle_root": "…64 hex…",
  "count": 42,
  "files": [ { "p": "src/main.js", "h": "…64 hex…" }, … ],
  "genesis": "0x…",   // tx hash of the first version = project UNID (versions ≥ 2)
  "prev": "0x…"       // tx hash of the directly preceding version (versions ≥ 2)
}
```

- `project_sha256` = SHA-256 over the canonical string `sort_by_path(path + "\n" + hash + "\n")` — reproducible by anyone from the file list.
- `merkle_root` = binary Merkle tree over the sorted leaf hashes (odd leaf duplicated). Enables **compact mode**: omit `files`, store only the root. Individual files are then proven with a Merkle path kept off-chain (e.g. shipped as `vericell.json` inside the release).
- Cost: 1 CKB = 1 byte of cell space, plus 61 CKB minimum cell overhead. Full manifest ≈ `(90 bytes header + ~110 bytes/file)` CKB; compact mode ≈ 300 CKB regardless of project size. **Capacity is locked, not burned** — consuming the cell returns it.

## 4. Versioning via cell consumption

CKB cells are immutable; updating means consuming the old cell and creating a new one in the same transaction:

```
tx1: ∅ ──────────────► Cell v1 (live)          genesis = tx1
tx2: Cell v1 (input) ─► Cell v2 (live)         prev = tx1, genesis = tx1
tx3: Cell v2 (input) ─► Cell v3 (live)         prev = tx2, genesis = tx1
```

- Only the lock owner can sign the consuming transaction → only the author can publish a successor.
- A verifier holding an old file still finds its proof in the **dead** cell (history is never deleted on CKB), sees it is superseded, and follows the consuming transaction forward to the current live cell.
- Withdrawing a project = consuming the cell without creating a successor (capacity refunds to the owner).

## 5. Project identity (UNID)

- **v1:** UNID = the tx hash of the first version; later versions carry it in `genesis`. The `prev` links are verifiable on-chain because the consuming tx literally spends the previous cell.
- **Production:** attach CKB's built-in **Type ID** type script to the proof cell. The type script args become a globally unique, *stable* identifier that survives every consume-and-recreate cycle and enforces that only one live cell per project exists. CCC exposes `ccc.hashTypeId(input, outputIndex)`. Type ID also makes indexing trivial: query live cells by type script.

## 6. Database (indexer-maintained)

SQLite for a single-node deployment, PostgreSQL for scale — identical schema:

```sql
CREATE TABLE projects (
  unid          TEXT PRIMARY KEY,     -- type ID args (or genesis tx hash)
  title         TEXT NOT NULL,
  source_url    TEXT,
  ckb_address   TEXT NOT NULL,        -- owner lock as address
  created_at    TIMESTAMPTZ NOT NULL, -- block timestamp of first version
  active        BOOLEAN NOT NULL,     -- true while a live cell exists
  live_tx_hash  TEXT,
  live_index    INTEGER DEFAULT 0
);

CREATE TABLE versions (
  tx_hash        TEXT PRIMARY KEY,
  unid           TEXT REFERENCES projects(unid),
  version_no     INTEGER,
  prev_tx_hash   TEXT,
  project_sha256 TEXT NOT NULL,
  merkle_root    TEXT,
  block_number   BIGINT,
  block_time     TIMESTAMPTZ,
  status         TEXT NOT NULL        -- pending | committed | consumed
);

-- backward search: any file hash → project (the "SHA-256 list" requirement)
CREATE TABLE hashes (
  sha256   TEXT NOT NULL,
  tx_hash  TEXT REFERENCES versions(tx_hash),
  path     TEXT,
  PRIMARY KEY (sha256, tx_hash, path)
);
CREATE INDEX idx_hashes_sha ON hashes (sha256);

CREATE TABLE api_keys (
  key_hash    TEXT PRIMARY KEY,       -- store only the hash of the key
  label       TEXT,
  created_at  TIMESTAMPTZ,
  rate_limit  INTEGER DEFAULT 60
);

CREATE TABLE webhooks (
  id        TEXT PRIMARY KEY,
  key_hash  TEXT REFERENCES api_keys(key_hash),
  unid      TEXT,                     -- NULL = all projects of this key
  url       TEXT NOT NULL,
  events    TEXT NOT NULL             -- committed,consumed,superseded
);

CREATE TABLE sync_state (             -- indexer cursor, reorg-safe
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_block_number BIGINT,
  last_block_hash   TEXT
);
```

The **indexer worker** follows the chain (CKB indexer RPC, filtered by the VeriCell type script once Type ID is deployed), parses manifests, maintains these tables, and handles reorgs by rolling back to the fork point using `sync_state`.

## 7. REST API (`/api/v1`)

OpenAPI 3.1 spec served at `/api/v1/openapi.json`, interactive docs at `/api/v1/docs`. JSON everywhere; errors follow RFC 9457 (`application/problem+json`).

### 7.1 Public endpoints — no authentication (mirrors the "no login to search/verify" rule)

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects` | Search. Query params: `q` (title), `hash` (any SHA-256), `address`, `active`, `page`, `limit` |
| GET | `/projects/{unid}` | Project record + current live version + full version chain |
| GET | `/versions/{txHash}` | One version: manifest, chain status (live/consumed), block number & timestamp, owner |
| GET | `/hashes/{sha256}` | Backward search: every project/version/path containing this file hash |
| GET | `/verify/{sha256}` | Convenience verdict: `{ found, live, project, version, block_time, path }` |
| GET | `/stats` | Totals: projects, versions, hashes indexed, sync height |
| GET | `/health` | Liveness + indexer lag |

Verification never uploads files: clients hash locally (CLI, browser, `sha256sum`) and query by hash.

### 7.2 Authenticated endpoints — `Authorization: Bearer <api-key>`

Two anchoring modes, because automation and self-custody pull in different directions:

**A. Non-custodial (recommended):** the API prepares, the client signs.

| Method | Path | Purpose |
|---|---|---|
| POST | `/proofs/prepare` | Body: manifest draft (+ optional `prev_tx_hash` for a new version, + payer lock). Returns an **unsigned CKB transaction skeleton** and the exact capacity required. |
| POST | `/proofs/submit` | Body: the signed transaction. API broadcasts it, creates a `pending` version row, returns `tx_hash`. |

The user's key never leaves their machine; the CLI wraps both calls around a local CCC signer.

**B. Custodial service-wallet (CI convenience):** the API signs with a server-held hot wallet.

| Method | Path | Purpose |
|---|---|---|
| POST | `/proofs` | Body: manifest draft. API funds, signs and broadcasts. The cell lock is the **service wallet**, so the manifest must include a `declared_author` field and, ideally, a detached signature by the author's long-term key. Trade-off documented to the caller in the response. |
| POST | `/proofs/{unid}/versions` | New version: consumes the current live cell, creates the successor |
| DELETE | `/proofs/{unid}` | Withdraw: consumes the live cell without successor; capacity refunds to the payer |

All mutating endpoints accept an `Idempotency-Key` header — retries never double-anchor.

### 7.3 Webhooks

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks` | Register `{ url, events, unid? }`. Events: `committed` (tx confirmed), `consumed`, `superseded` (new version live) |
| DELETE | `/webhooks/{id}` | Remove |

Deliveries are signed with an HMAC header (`X-VeriCell-Signature`) so receivers can authenticate the callback.

### 7.4 Rate limiting & keys

Public endpoints: per-IP limit (e.g. 60 req/min). Keyed endpoints: per-key limit from `api_keys.rate_limit`. Keys are shown once at creation and stored only as hashes.

### 7.5 Example automation flow (CI release)

```bash
# in a GitHub Action, after building release artifacts
vericell hash ./dist --out manifest.json
vericell anchor manifest.json \
  --api https://api.vericell.example/api/v1 \
  --key $VERICELL_API_KEY \
  --mode non-custodial --signer-key-file ./ci-ckb-key   # or --mode custodial
# poll or receive webhook: status pending → committed
vericell status <unid>
```

## 8. Input sources (web app)

| Source        | Method                                                                      |
|---------------|------------------------------------------------------------------------------|
| Local files   | `<input type="file" multiple>` + drag-and-drop, hashed via `crypto.subtle`   |
| Folder        | `<input webkitdirectory>` preserving relative paths                          |
| GitHub repo   | GitHub API tree + `raw.githubusercontent.com` (CORS-enabled), ≤ 200 files    |
| URL           | direct `fetch` — works only where the server sends CORS headers              |
| Paste hashes  | for artifacts hashed elsewhere (`sha256sum`, CI pipelines, ZIP archives)     |

## 9. Security & limitations

- **Proof of knowledge, not authorship in the legal sense.** The chain proves the wallet owner knew the hashes at block time — first-to-anchor wins. Anchor *before* publishing.
- **Manifest timestamps are claims; block timestamps are authoritative.** Both are shown, labeled.
- **Custodial mode weakens the ownership property** (the cell lock is the service wallet). It exists for CI convenience only; the `declared_author` + detached-signature pattern partially restores attribution. Default and recommendation: non-custodial.
- **API keys** are bearer secrets: hashed at rest, never logged, revocable, per-key rate limits.
- **CORS** limits the URL source in-browser; the CLI or API-side fetching covers server-to-server cases.
- **JSON in cell data** is readable but not the cheapest encoding; Molecule (CKB's canonical serialization) would cut size ~30% — natural v2 format.
- Anchoring a false manifest is possible — verification always means recomputing hashes from real files, never trusting a title.

## 10. Roadmap

1. Type ID type script (stable UNID + trivial indexing)
2. Public indexer + REST API (this document, §6–7)
3. CLI + GitHub Action for CI/CD anchoring
4. Molecule-encoded manifests; optional compression of the file table
5. Off-chain Merkle-path files (`vericell.json`) inside releases for compact mode
6. Secondary OpenTimestamps anchor of `project_sha256` to Bitcoin for cross-chain redundancy
7. DID/signature layer so authorship survives wallet rotation

## 11. Running it

```bash
# web app (v1, standalone)
npm install && npm run dev        # http://localhost:5173

# full stack (once built per ClaudeCodeInstruction.md)
docker compose up                 # API + indexer + DB, web served statically
```

### Network flag

The target chain is a single constant resolved from the environment, defined once in `packages/core/src/network.ts` and imported by every package:

| Variable | Where | Values | Default |
|---|---|---|---|
| `VERICELL_NETWORK` | API, indexer, CLI (runtime) | `devnet` \| `testnet` \| `mainnet` | `testnet` |
| `VITE_VERICELL_NETWORK` | web app (baked at build time) | same | `testnet` |

Testing and staging always run on **testnet** (test CKB: faucet.nervos.org); automated tests use a local **devnet** (offckb). Deploying online to **mainnet** means setting the variable at deploy time — no code changes. Safeguards: the DB file is network-scoped (`vericell.<network>.sqlite`), the active network is shown in the web top bar, `/health`, `/stats` and CLI output, and custodial mode on mainnet additionally requires `MAINNET_CONFIRM=1`.

Wallets: JoyID via CCC; every other CCC signer plugs into the same `Signer` interface.
