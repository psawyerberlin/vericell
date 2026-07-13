#!/bin/bash
set -e
cd ~/vericell

OUT=~/vericell/stats-export/stats.json

docker compose cp api:/data/vericell.testnet.sqlite /tmp/vt.sqlite
docker compose cp api:/data/vericell.mainnet.sqlite /tmp/vm.sqlite

TESTNET=$(sqlite3 /tmp/vt.sqlite "SELECT json_object('projects', (SELECT COUNT(*) FROM projects), 'versions', (SELECT COUNT(*) FROM versions), 'hashes', (SELECT COUNT(*) FROM hashes));")
MAINNET=$(sqlite3 /tmp/vm.sqlite "SELECT json_object('projects', (SELECT COUNT(*) FROM projects), 'versions', (SELECT COUNT(*) FROM versions), 'hashes', (SELECT COUNT(*) FROM hashes));")

echo "{\"updated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"testnet\": $TESTNET, \"mainnet\": $MAINNET}" > "$OUT"

rm -f /tmp/vt.sqlite /tmp/vm.sqlite
