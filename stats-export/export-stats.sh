#!/bin/bash
set -e
cd ~/vericell

OUT=~/vericell/stats-export/stats.json

docker compose cp api:/data/vericell.testnet.sqlite /tmp/vt.sqlite
docker compose cp api:/data/vericell.testnet.sqlite-wal /tmp/vt.sqlite-wal 2>/dev/null || true
docker compose cp api:/data/vericell.testnet.sqlite-shm /tmp/vt.sqlite-shm 2>/dev/null || true

docker compose cp api:/data/vericell.mainnet.sqlite /tmp/vm.sqlite
docker compose cp api:/data/vericell.mainnet.sqlite-wal /tmp/vm.sqlite-wal 2>/dev/null || true
docker compose cp api:/data/vericell.mainnet.sqlite-shm /tmp/vm.sqlite-shm 2>/dev/null || true

TESTNET=$(sqlite3 /tmp/vt.sqlite "SELECT json_object('projects', (SELECT COUNT(*) FROM projects), 'versions', (SELECT COUNT(*) FROM versions), 'hashes', (SELECT COUNT(*) FROM hashes));")
MAINNET=$(sqlite3 /tmp/vm.sqlite "SELECT json_object('projects', (SELECT COUNT(*) FROM projects), 'versions', (SELECT COUNT(*) FROM versions), 'hashes', (SELECT COUNT(*) FROM hashes));")

echo "{\"updated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"testnet\": $TESTNET, \"mainnet\": $MAINNET}" > "$OUT"

rm -f /tmp/vt.sqlite /tmp/vt.sqlite-wal /tmp/vt.sqlite-shm /tmp/vm.sqlite /tmp/vm.sqlite-wal /tmp/vm.sqlite-shm
