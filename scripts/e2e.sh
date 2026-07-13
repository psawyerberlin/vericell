#!/usr/bin/env bash
# End-to-end pipeline check (Phase 9 acceptance): from a clean state, bring
# up an offckb devnet, run migrations + the indexer + the API, then drive
# the real vericell CLI through hash -> anchor -> verify, and assert the
# anchored project is served back by GET /api/v1/projects.
#
# Prerequisites (not started by this script):
#   - `pnpm build` already run (this script runs the compiled dist/, not ts).
#   - `@offckb/cli` installed (`npm i -g @offckb/cli`) if no devnet is
#     already reachable at VERICELL_DEVNET_RPC_URL / the default
#     http://127.0.0.1:28114 — this script starts one itself if needed.
#
# Everything else — the devnet account, its system-scripts file, the DB, the
# API's admin token, the fixture files anchored — is fresh per run and
# cleaned up on exit (see the `cleanup` trap below).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[e2e] $*"; }
fail() {
  echo "[e2e] FAILED: $*" >&2
  exit 1
}

for f in packages/api/dist/server/run.js packages/api/dist/indexer/run.js packages/cli/dist/index.js; do
  [ -f "$f" ] || fail "$f not found — run \`pnpm build\` first."
done

command -v offckb >/dev/null 2>&1 || fail "offckb CLI not found on PATH — run \`npm i -g @offckb/cli\`."

DEVNET_RPC_URL="${VERICELL_DEVNET_RPC_URL:-http://127.0.0.1:28114}"
API_PORT="${E2E_API_PORT:-38080}"
API_URL="http://127.0.0.1:${API_PORT}/api/v1"
ADMIN_TOKEN="e2e-admin-$(date +%s)"
POLL_INTERVAL_MS=1000

SCRATCH_DIR="$(mktemp -d)"
DB_PATH="${SCRATCH_DIR}/vericell.e2e.sqlite"
SCRIPTS_FILE="${SCRATCH_DIR}/devnet-scripts.json"
SIGNER_KEY_FILE="${SCRATCH_DIR}/signer.key"
FIXTURE_DIR="${SCRATCH_DIR}/fixture"
MANIFEST_PATH="${SCRATCH_DIR}/manifest.json"

API_PID=""
INDEXER_PID=""
OFFCKB_PID=""

cleanup() {
  log "cleaning up"
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$INDEXER_PID" ] && kill "$INDEXER_PID" 2>/dev/null || true
  [ -n "$OFFCKB_PID" ] && kill "$OFFCKB_PID" 2>/dev/null || true
  # Belt-and-suspenders: `kill "$PID"` occasionally misses a child that
  # ended up under an intermediate shell rather than being the direct
  # backgrounded process (observed in practice). Sweep by exact script path
  # instead of relying on the captured PID alone — narrow enough that it
  # can't match an unrelated process.
  pkill -f "packages/api/dist/indexer/run.js" 2>/dev/null || true
  pkill -f "packages/api/dist/server/run.js" 2>/dev/null || true
  rm -rf "$SCRATCH_DIR"
}
trap cleanup EXIT

devnet_reachable() {
  curl -s -m 2 -o /dev/null -w "%{http_code}" \
    -X POST -H 'content-type: application/json' \
    -d '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}' \
    "$DEVNET_RPC_URL" 2>/dev/null | grep -q "^200$"
}

wait_for() {
  local desc="$1" check="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if eval "$check" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for $desc"
}

# --- 1. offckb devnet ------------------------------------------------------
if devnet_reachable; then
  log "offckb devnet already reachable at $DEVNET_RPC_URL"
else
  log "starting offckb devnet"
  offckb node >"${SCRATCH_DIR}/offckb.log" 2>&1 &
  OFFCKB_PID=$!
  wait_for "offckb devnet at $DEVNET_RPC_URL" "devnet_reachable" 60
  log "offckb devnet ready"
fi

log "exporting devnet system-scripts"
offckb system-scripts --export-style ccc --network devnet 2>/dev/null | tail -n +2 >"$SCRIPTS_FILE"

if [ -n "${VERICELL_OFFCKB_PRIVATE_KEY:-}" ]; then
  PRIVATE_KEY="$VERICELL_OFFCKB_PRIVATE_KEY"
else
  log "picking a funded devnet account (offckb accounts, account #0)"
  PRIVATE_KEY="$(offckb accounts 2>/dev/null | grep -A2 '"#": 0$' | grep '^privkey:' | awk '{print $2}')"
  [ -n "$PRIVATE_KEY" ] || fail "could not derive a devnet private key from \`offckb accounts\`"
fi
echo "$PRIVATE_KEY" >"$SIGNER_KEY_FILE"

export VERICELL_NETWORK=devnet
export VERICELL_DEVNET_RPC_URL="$DEVNET_RPC_URL"
export VERICELL_DEVNET_SCRIPTS_FILE="$SCRIPTS_FILE"
export DB_PATH
export LOG_LEVEL="${LOG_LEVEL:-warn}"

# --- 2. migrations ----------------------------------------------------------
# openDb() runs pending migrations on open. Run once, upfront, and exit —
# rather than letting the indexer and API race to apply them independently
# when both are started moments apart against the same fresh DB_PATH.
log "running migrations against a fresh DB ($DB_PATH)"
node --input-type=module -e "
import { openDb } from '${REPO_ROOT}/packages/api/dist/db/open.js';
openDb(process.env.DB_PATH, 'devnet').close();
"

# --- 3. indexer --------------------------------------------------------
log "starting the indexer"
POLL_INTERVAL_MS="$POLL_INTERVAL_MS" node packages/api/dist/indexer/run.js \
  >"${SCRATCH_DIR}/indexer.log" 2>&1 &
INDEXER_PID=$!

# --- 3. API ------------------------------------------------------------
log "starting the API on :$API_PORT"
PORT="$API_PORT" ADMIN_TOKEN="$ADMIN_TOKEN" node packages/api/dist/server/run.js \
  >"${SCRATCH_DIR}/api.log" 2>&1 &
API_PID=$!
wait_for "API health at $API_URL/health" "curl -sf $API_URL/health" 30
log "API ready"

log "minting an API key"
KEY_JSON="$(curl -sf -X POST "$API_URL/keys" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"label":"e2e"}')"
API_KEY="$(node -e "console.log(JSON.parse(process.argv[1]).key)" "$KEY_JSON")"
[ -n "$API_KEY" ] || fail "failed to mint an API key: $KEY_JSON"

# --- 4. CLI: hash -> anchor -> verify ---------------------------------------
mkdir -p "$FIXTURE_DIR"
echo "vericell e2e fixture $(date +%s)" >"${FIXTURE_DIR}/release.txt"

log "vericell hash"
node packages/cli/dist/index.js hash "$FIXTURE_DIR" --out "$MANIFEST_PATH" --json

log "vericell anchor"
ANCHOR_JSON="$(node packages/cli/dist/index.js anchor "$MANIFEST_PATH" \
  --api "$API_URL" --key "$API_KEY" \
  --signer-key-file "$SIGNER_KEY_FILE" --json)"
TX_HASH="$(node -e "console.log(JSON.parse(process.argv[1]).tx_hash)" "$ANCHOR_JSON")"
UNID="$(node -e "console.log(JSON.parse(process.argv[1]).unid)" "$ANCHOR_JSON")"
[ -n "$TX_HASH" ] && [ -n "$UNID" ] || fail "anchor did not return a tx_hash/unid: $ANCHOR_JSON"
log "anchored: tx_hash=$TX_HASH unid=$UNID"

log "vericell verify (waiting for the indexer to catch up)"
VERIFY_OK=0
for _ in $(seq 1 60); do
  if node packages/cli/dist/index.js verify "${FIXTURE_DIR}/release.txt" --api "$API_URL"; then
    VERIFY_OK=1
    break
  fi
  sleep 1
done
[ "$VERIFY_OK" = "1" ] || fail "verify never returned exit 0 — indexer didn't catch up in time"

# --- 5. assert the project is served by GET /projects -----------------------
log "asserting GET /api/v1/projects serves the anchored project"
PROJECTS_JSON="$(curl -sf "$API_URL/projects?limit=100")"
FOUND="$(node -e "
const body = JSON.parse(process.argv[1]);
const unid = process.argv[2];
console.log(body.data.some((p) => p.unid === unid) ? 'yes' : 'no');
" "$PROJECTS_JSON" "$UNID")"
[ "$FOUND" = "yes" ] || fail "GET /api/v1/projects did not include unid $UNID: $PROJECTS_JSON"

log "vericell status"
node packages/cli/dist/index.js status "$UNID" --api "$API_URL"

log "PASSED: offckb -> migrations/indexer -> API -> CLI hash+anchor+verify -> GET /projects"
