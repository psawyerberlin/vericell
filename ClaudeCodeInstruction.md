# ClaudeCodeInstruction.md — Build VeriCell (full version)

Instructions for **Claude Code** to implement the complete VeriCell stack: shared core library, chain layer, indexer, REST API, web app, CLI, tests and deployment.

**How to use this file:** place it in the repo root together with `TECHNICAL.md` (the specification — read it first, it is authoritative for data model, manifest format and API surface). Work through the phases **in order, one phase per session/commit**. Do not start a phase before the previous phase's acceptance criteria pass. If a decision is not covered here or in TECHNICAL.md, choose the simplest option and record it in `docs/DECISIONS.md`.

---

## Global rules (apply to every phase)

- Language: **TypeScript** everywhere, Node ≥ 20, `"type": "module"`.
- Monorepo: **pnpm workspaces**. Layout:
  ```
  packages/core   — pure logic: hashing, Merkle, manifest (no DOM, no Node-only APIs)
  packages/chain  — CKB layer on @ckb-ccc/ccc: tx building, type ID, RPC helpers
  packages/api    — Fastify REST API + indexer worker + DB (better-sqlite3)
  packages/web    — Vite SPA (the existing v1 app is the starting point)
  packages/cli    — vericell command-line tool
  docs/           — TECHNICAL.md, DECISIONS.md, openapi generated here
  ```
- CKB library: npm package **`@ckb-ccc/ccc`** (repo is github.com/ckb-devrel/ccc — do not confuse the names). Wallet API: `new ccc.JoyId.CkbSigner(client, name, icon)`.
- Hash algorithm is **SHA-256**. Never write "SHA254".
- **Network flag — single source of truth.** The target chain is controlled by ONE constant, defined once in `packages/core/src/network.ts` and imported everywhere else — no package may hardcode a network or an RPC/explorer URL:
  ```ts
  export type Network = "devnet" | "testnet" | "mainnet";
  export const NETWORK: Network =
    (globalThis.process?.env?.VERICELL_NETWORK          // api, indexer, cli
     ?? import.meta?.env?.VITE_VERICELL_NETWORK         // web (baked at build time)
     ?? "testnet") as Network;                           // default: TESTNET
  export const EXPLORER_URL = { devnet: "http://localhost:8114-local", testnet: "https://testnet.explorer.nervos.org", mainnet: "https://explorer.nervos.org" }[NETWORK];
  ```
  (Implement the env lookup robustly per runtime; the snippet shows intent, not final code.) Rules that follow from it: default is **testnet** for all local testing and staging; **mainnet is opt-in only**, selected exclusively by setting `VERICELL_NETWORK=mainnet` (server) / `VITE_VERICELL_NETWORK=mainnet` (web build) at deploy time. Unit/integration tests run on **devnet** via offckb (`npm i -g @offckb/cli`). The API `/health` and `/stats` responses, the CLI output, and the web top bar must all display the active network. The DB path must be network-scoped (e.g. `vericell.testnet.sqlite`) so a testnet index can never be served as mainnet data. On mainnet startup, the API logs a prominent warning and refuses to start custodial mode unless `MAINNET_CONFIRM=1` is also set.
- Validation: **zod** schemas for every external input (API bodies, manifests, env).
- Tests: **vitest**. Every phase adds tests; `pnpm test` must stay green.
- Secrets: only via environment (`.env` is gitignored; maintain `.env.example`). Never commit keys; never log API keys or private keys.
- Errors in the API: RFC 9457 `application/problem+json`.
- Each phase ends with: run the listed verification commands, then a single commit `phase(N): <summary>`.

---

## Phase 0 — Repository bootstrap

**Goal:** empty but fully wired monorepo.

Tasks:
1. `pnpm init`, workspace file, `packages/*` scaffolds with their own `package.json` + `tsconfig.json` extending a root `tsconfig.base.json` (strict mode on).
2. Root scripts: `pnpm build`, `pnpm test`, `pnpm lint` (eslint + prettier), running across all workspaces.
3. Move the existing v1 SPA files (`index.html`, `src/`, `public/`) into `packages/web` unchanged; confirm `pnpm --filter web dev` still serves it.
4. Copy `TECHNICAL.md` into `docs/`; create empty `docs/DECISIONS.md`.
5. GitHub Actions workflow `.github/workflows/ci.yml`: install, lint, build, test on push.

**Acceptance criteria:** `pnpm build && pnpm test && pnpm lint` all succeed; web app runs from its new location; CI file present.

---

## Phase 1 — `packages/core`: hashing, Merkle, manifest

**Goal:** the deterministic cryptographic heart, isomorphic (browser + Node — use the Web Crypto API, available in Node ≥ 20 as `globalThis.crypto`).

Tasks:
1. `sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string>`.
2. `projectHash(entries)` — SHA-256 over the canonical string defined in TECHNICAL.md §3 (sort by path, `path\nhash\n` concatenation). This exact definition is normative; write it once here and nowhere else.
3. `merkleRoot(entries)` and `merkleProof(entries, path)` + `verifyMerkleProof(leafHash, proof, root)` — binary tree over sorted leaves, odd leaf duplicated.
4. Manifest: zod schema matching TECHNICAL.md §3 exactly (`app`, `v`, `title`, `created`, `source?`, `project_sha256`, `merkle_root`, `count`, `files?`, `genesis?`, `prev?`, `declared_author?`), plus `encodeManifest` → `Uint8Array` (UTF-8 JSON, stable key order) and `decodeManifest` with validation.
5. `estimateCellCost(manifest)` — bytes + 61 CKB overhead, returns both full and compact figures.
6. `network.ts` — the network flag module described in the global rules: `Network` type, `NETWORK` constant resolved from env with **testnet default**, `EXPLORER_URL`, and `isMainnet()` helper. Export it from the package root; every other package imports the network from here and only here.

**Tests (crucial — these are the compatibility contract):**
- Fixed vectors: hash of empty input, of `"abc"` (`ba7816bf…`), a 3-file project hash computed by hand, a 4-leaf and 5-leaf Merkle root.
- Round-trip encode/decode; rejection of invalid manifests; Merkle proof verify for every leaf of a 7-leaf tree.

**Acceptance criteria:** `pnpm --filter core test` green; package has **zero** runtime dependencies except zod.

---

## Phase 2 — `packages/chain`: CKB transactions

**Goal:** everything that touches the chain, testable against offckb devnet.

Tasks:
1. `makeClient(network?: Network)` wrapping CCC clients — `ClientPublicTestnet` / `ClientPublicMainnet`, devnet = configurable RPC URL from env. When called without an argument it uses `NETWORK` from `packages/core/network.ts`; the explicit parameter exists only for tests.
2. `buildAnchorTx({ lock, manifestBytes, prevOutPoint? })` — output cell with auto minimum capacity, `outputsData = [manifestBytes]`, optional input consuming the previous version. Use `ccc.Transaction.from`, `completeInputsByCapacity`, `completeFeeBy`.
3. **Type ID support:** `buildAnchorTxWithTypeId(...)` — on first version compute args via `ccc.hashTypeId(firstInput, outputIndex)`; on updates carry the type script over unchanged. Document in DECISIONS.md whether v1 cells (no type script) remain readable (they must).
4. `fetchProof(client, txHash, index)` — returns `{ manifest, live, blockNumber, blockTime, ownerAddress }` (mirror of the v1 web function, now shared).
5. `findLiveProofsByTypeId(client, typeArgs)` and `findVeriCells(client, lock)` using CCC's cell collector.
6. Withdraw builder: consume without successor.

**Tests:** integration suite gated behind `OFFCKB=1`: spin up offckb, anchor → assert live; anchor v2 consuming v1 → assert v1 dead, v2 live, `genesis`/`prev` correct; withdraw → capacity returned. Plus pure unit tests for tx shaping with mocked client.

**Acceptance criteria:** unit tests green always; integration suite green on a machine with offckb.

---

## Phase 3 — `packages/api`: database + indexer worker

**Goal:** chain-derived database per TECHNICAL.md §6.

Tasks:
1. better-sqlite3 with migration runner (plain `.sql` files in `migrations/`); implement the §6 schema verbatim (SQLite dialect: `TEXT` timestamps ISO-8601).
2. Indexer worker (`src/indexer.ts`): poll loop —
   - read `sync_state`; fetch blocks from cursor to tip via CCC client;
   - for each tx: detect VeriCell outputs (type script match when Type ID present; fallback heuristic: data starts with `{"app":"vericell"` for legacy cells), decode manifest with `core`, upsert `projects` / `versions` / `hashes`;
   - detect consumed proof cells among inputs → set version `status = consumed`; if a successor output exists in the same tx, link it and update `projects.live_tx_hash`, else set `projects.active = false`;
   - **reorg handling:** store `last_block_hash`; if the parent hash chain breaks, roll back N blocks (delete/recompute rows with `block_number >` fork point) and resume.
3. Confirmation tracking: versions enter as `pending` when submitted via API (Phase 5) and flip to `committed` when the indexer sees them.
4. Structured logging (pino), configurable poll interval, graceful shutdown.

**Tests:** run against offckb — anchor 3 projects (one with 2 versions) via `chain`, run indexer to tip, assert DB rows: counts, `active` flags, backward hash lookup, version chain. Simulated reorg test with a mocked client.

**Acceptance criteria:** `pnpm --filter api test` green; indexer resumes cleanly after kill/restart (cursor test).

---

## Phase 4 — `packages/api`: public REST endpoints

**Goal:** read-only API, TECHNICAL.md §7.1, no auth.

Tasks:
1. Fastify app factory (`buildServer()`), separated from the listener for testability.
2. Endpoints exactly as §7.1: `GET /api/v1/projects` (filters `q,hash,address,active` + pagination), `/projects/{unid}`, `/versions/{txHash}`, `/hashes/{sha256}`, `/verify/{sha256}`, `/stats`, `/health` (reports indexer lag = tip − cursor).
3. zod-validated params; problem+json errors; per-IP rate limiting (`@fastify/rate-limit`, default 60/min); CORS enabled for GET.
4. OpenAPI 3.1 via `@fastify/swagger` + `@fastify/swagger-ui`: spec at `/api/v1/openapi.json`, docs UI at `/api/v1/docs`. Also write the generated spec to `docs/openapi.json` in the build.
5. `/versions/{txHash}` must also work for proofs **not yet indexed**: fall back to a direct chain lookup via `chain.fetchProof` and say so in the response (`"source": "chain"` vs `"index"`).

**Tests:** fastify `inject()` tests over a seeded SQLite fixture: every endpoint happy path, 404s, validation 400s, rate-limit 429.

**Acceptance criteria:** all §7.1 routes implemented and tested; OpenAPI docs render.

---

## Phase 5 — `packages/api`: authenticated write endpoints

**Goal:** automation anchoring, TECHNICAL.md §7.2.

Tasks:
1. API keys: `POST /api/v1/keys` guarded by an `ADMIN_TOKEN` env; return the key **once**, store SHA-256 of it in `api_keys`. Bearer-auth Fastify hook resolving key hash → per-key rate limit.
2. **Non-custodial flow:**
   - `POST /proofs/prepare` — body: manifest draft + payer lock/address (+ `prev_tx_hash?`). Server validates with `core`, builds the unsigned tx with `chain` (no signing), returns tx JSON + required capacity + computed `project_sha256`.
   - `POST /proofs/submit` — body: signed tx. Server broadcasts, inserts `pending` version, returns `tx_hash` + `unid`.
3. **Custodial flow (feature-flag `CUSTODIAL_ENABLED`):** `POST /proofs`, `POST /proofs/{unid}/versions`, `DELETE /proofs/{unid}` — signed by a service key from env (`SERVICE_PRIVATE_KEY`, CCC `SignerCkbPrivateKey`). Require `declared_author` in the manifest for custodial anchors; echo the trade-off note in the response per TECHNICAL.md §7.2-B.
4. `Idempotency-Key` support on all POSTs: table of key→response, replay returns the stored response.
5. Never log request bodies on these routes.

**Tests:** offckb integration — prepare→sign(with a local test key)→submit→indexer sees it→status flips to committed; custodial anchor + new version + withdraw; idempotent replay; auth failures 401/403.

**Acceptance criteria:** both flows anchor real cells on devnet; idempotency proven by test.

---

## Phase 6 — Webhooks

**Goal:** TECHNICAL.md §7.3.

Tasks:
1. `POST /webhooks`, `DELETE /webhooks/{id}` (key-scoped). Events: `committed`, `consumed`, `superseded`.
2. Dispatcher inside the indexer loop: on state transitions, enqueue deliveries (simple DB-backed queue), POST JSON with `X-VeriCell-Signature: sha256=HMAC(body, webhook_secret)`, retry with exponential backoff (max 5), mark dead after that.

**Tests:** local HTTP receiver in the test asserts payload + valid HMAC on a committed and a superseded event; retry test against a flaky receiver.

**Acceptance criteria:** events delivered and signed; retries observable in logs.

---

## Phase 7 — `packages/web`: upgrade the SPA

**Goal:** keep the v1 UX and all its rules (login only for creating; search/verify open), now backed by the API.

Tasks:
1. Replace localStorage-only search with API calls (`VITE_API_URL`); keep localStorage as offline fallback and label result provenance ("global index" vs "this device").
1b. Replace the v1 manual network `<select>` with the build-time network flag from `core/network.ts`: the deployed site targets exactly one network, shown as a read-only badge in the top bar (testnet builds get a visible "TESTNET" badge; mainnet builds a subtle one). Explorer links derive from `EXPLORER_URL`.
2. Refactor hashing/manifest code to import from `packages/core` (delete the duplicated functions).
3. Project detail: version timeline (genesis → … → live) rendered from `GET /projects/{unid}`; explorer links; live/consumed badges from the API.
4. Add an "API & automation" page section: how to get a key, curl examples, link to `/api/v1/docs`.
5. Keep the existing design system (tokens in `style.css`, fingerprint strips) — extend, don't restyle.

**Acceptance criteria:** app works with API up **and** gracefully without it; anchoring from the browser still non-custodial via JoyID; `pnpm --filter web build` clean.

---

## Phase 8 — `packages/cli`

**Goal:** the automation client, TECHNICAL.md §7.5.

Tasks:
1. Commands (commander or citty):
   - `vericell hash <dir|files…> [--out manifest.json] [--compact]` — walks files (respect `.gitignore` via `ignore` pkg), builds the manifest draft with `core`, prints `project_sha256`.
   - `vericell anchor <manifest.json> --api <url> --key <k> --mode non-custodial|custodial [--signer-key-file f] [--prev tx]` — non-custodial: prepare → sign locally with CCC private-key signer → submit.
   - `vericell verify <file> --api <url>` — hash locally, `GET /verify/{sha256}`, human-readable verdict, exit code 0/1.
   - `vericell status <unid> --api <url>`; `vericell withdraw <unid> …`.
2. `--json` flag on every command for machine output.
3. `examples/github-action.yml`: workflow that hashes `dist/` and anchors on release tags.

**Tests:** CLI e2e against the running API+offckb (execa); verify exit codes.

**Acceptance criteria:** the §7.5 flow works verbatim from a shell.

---

## Phase 9 — Hardening & full test pass

Tasks:
1. Security review checklist executed and written to `docs/SECURITY.md`: key handling, rate limits, input validation coverage, SQL injection (parameterized only), webhook SSRF guard (deny private IP ranges), custodial-mode warnings.
2. Load sanity: seed 10k projects / 200k hashes, assert `GET /hashes/{sha256}` < 50 ms (index check).
3. Coverage report; fill the biggest gaps; end-to-end script `scripts/e2e.sh` (offckb → indexer → api → cli anchor → web verify against a served build).

**Acceptance criteria:** `pnpm test` green from a clean clone; e2e script passes.

---

## Phase 10 — Packaging & deployment

Tasks:
1. `Dockerfile` for the API (multi-stage, distroless/alpine, non-root) and `docker-compose.yml`: api + indexer (same image, different command) + volume for SQLite; web built to static files served by Caddy/nginx container with `/api` reverse-proxy.
2. `.env.example` documenting every variable: `VERICELL_NETWORK` (devnet|testnet|**mainnet** — default testnet), `MAINNET_CONFIRM`, `RPC_URL`, `DB_PATH`, `ADMIN_TOKEN`, `CUSTODIAL_ENABLED`, `SERVICE_PRIVATE_KEY`, `PORT`, `POLL_INTERVAL_MS`. For the web build: `VITE_VERICELL_NETWORK`, `VITE_API_URL`.
2b. Compose ships two profiles: default (testnet, for staging/testing) and `docker compose --profile mainnet up`, which sets `VERICELL_NETWORK=mainnet` for api+indexer and builds the web bundle with `VITE_VERICELL_NETWORK=mainnet`. Going live online must require changing **only** this profile/env — zero code edits. Verify by grepping the codebase: the strings "testnet" and "mainnet" may appear only in `packages/core/src/network.ts`, tests, docs and compose files.
3. `README.md` at repo root: what it is, quickstart (compose up), links to TECHNICAL.md and the API docs; update TECHNICAL.md §11 if commands changed.
4. Tag `v1.0.0`. Optional dogfood step: run `vericell hash . && vericell anchor` on the repo itself and put the resulting UNID in the README.

**Acceptance criteria:** `docker compose up` on a clean machine yields a working stack pointed at testnet; README quickstart verified.

---

## Decision defaults (use unless overridden)

| Topic | Default |
|---|---|
| DB | better-sqlite3; Postgres left as documented migration path |
| HTTP framework | Fastify 5 |
| Manifest encoding | JSON v1 (Molecule is roadmap, not this build) |
| Custodial mode | implemented but **off by default** |
| GitHub file limit (web) | 200 files; CLI has no limit |
| Pagination | `page`/`limit`, max 100 |
